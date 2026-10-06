<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.metric"
                    :items="metricOptions"
                    :label="$t('AntigravityUsage.UI.metric')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('AntigravityUsage.UI.lang')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showResetTime"
                    :label="$t('AntigravityUsage.UI.showResetTime')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('AntigravityUsage.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <template v-for="group in groupLines" :key="group.key">
                    <p class="text-caption mx-2">{{ group.line }}</p>
                    <p
                        v-if="group.description"
                        class="text-caption text-medium-emphasis mx-4"
                    >
                        {{ group.description }}
                    </p>
                </template>
                <p v-if="hintText" class="text-caption mx-2">{{ hintText }}</p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Antigravity Usage key settings: which limit the meter shows. The backend
// (src/providers/antigravity/usage.ts) answers 'usage-status' with the
// metrics it found, the model groups and their limits, the plan name and
// which Antigravity program answered, or an error and the problem behind it.
const CID = "dev.sese.flexbar_claude_code_usage.antigravity_usage";

// today's groups (the server's bucket ids), shown before the first answer
const KNOWN_GROUPS = [
    { key: "gemini", name: "Gemini" },
    { key: "3p", name: "Claude / GPT-OSS" },
];
const KNOWN_WINDOWS = ["5h", "weekly"];

// window words of the limits
const WINDOWS = {
    "5h": "window5h",
    daily: "windowDaily",
    weekly: "windowWeekly",
    monthly: "windowMonthly",
};

// problems (see usageText.ts) → the reason in the status line
const PROBLEMS = {
    "not-installed": "problemNotInstalled",
    "cli-only": "problemCliOnly",
    "not-running": "problemNotRunning",
    "signed-out": "problemSignedOut",
    "no-quota": "problemNoQuota",
    "old-version": "problemOldVersion",
    unreachable: "problemUnreachable",
    "unsupported-os": "problemUnsupportedOs",
};

// other failures by ProviderError code
const CODES = {
    network: "errorNetwork",
    http: "errorHttp",
    parse: "errorParse",
    "rate-limited": "errorRateLimited",
};

// problems → hint below the status line
const HINTS = {
    "not-installed": "hintInstall",
    "not-running": "hintOpen",
    "cli-only": "hintCliOnly",
    "signed-out": "hintSignIn",
    unreachable: "hintOpen",
    "old-version": "hintUpdate",
};

function bucketId(key, window) {
    return key === "gemini" || key === "3p"
        ? `${key}-${window}`
        : `bucket:${key}-${window}`;
}

export default {
    props: {
        modelValue: {
            type: Object,
            required: true,
        },
    },
    emits: ["update:modelValue"],
    data() {
        return {
            reply: null,
            statusText: "",
            problem: null,
        };
    },
    computed: {
        groups() {
            return this.reply && Array.isArray(this.reply.groups)
                ? this.reply.groups
                : [];
        },
        metricOptions() {
            const t = (key, params) =>
                this.$t(`AntigravityUsage.UI.${key}`, params);
            const options = [{ title: t("metricDefault"), value: "" }];
            const add = (title, value) => {
                if (!options.some(o => o.value === value)) {
                    options.push({ title, value });
                }
            };
            const windowText = window =>
                WINDOWS[window] ? t(WINDOWS[window]) : window || "?";
            const views = (this.reply && this.reply.views) || [];
            const seen = new Set();
            for (const group of this.groups) {
                seen.add(group.key);
                const buckets = (group.buckets || []).filter(
                    b => !b.disabled && b.left !== null && b.left !== undefined
                );
                if (buckets.length >= 2) {
                    add(
                        t("choiceGroup", { group: group.name }),
                        `group:${group.key}`
                    );
                }
                for (const bucket of buckets) {
                    add(
                        t("choiceBucket", {
                            group: group.name,
                            window: windowText(bucket.window),
                        }),
                        bucket.id
                    );
                }
                if (views.some(v => v.id === `${group.key}-dual`)) {
                    add(
                        t("choiceDual", { group: group.name }),
                        `${group.key}-dual`
                    );
                }
            }
            // today's groups, also while Antigravity is not running
            for (const group of KNOWN_GROUPS) {
                if (seen.has(group.key)) continue;
                add(
                    t("choiceGroup", { group: group.name }),
                    `group:${group.key}`
                );
                for (const window of KNOWN_WINDOWS) {
                    add(
                        t("choiceBucket", {
                            group: group.name,
                            window: windowText(window),
                        }),
                        bucketId(group.key, window)
                    );
                }
                add(
                    t("choiceDual", { group: group.name }),
                    `${group.key}-dual`
                );
            }
            // per-model quota, when the server reports no groups
            if (this.reply && this.reply.models) {
                for (const metric of this.reply.metrics || []) {
                    if (!String(metric.id).startsWith("model:")) continue;
                    add(t("choiceModel", { name: metric.label }), metric.id);
                }
            }
            const current = this.modelValue.data.metric;
            if (current && !options.some(o => o.value === current)) {
                options.push({ title: current, value: current });
            }
            return options;
        },
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
        groupLines() {
            const t = (key, params) =>
                this.$t(`AntigravityUsage.UI.${key}`, params);
            const windowText = window =>
                WINDOWS[window] ? t(WINDOWS[window]) : window || "?";
            return this.groups.map(group => {
                const limits = (group.buckets || []).map(bucket => {
                    const window = windowText(bucket.window);
                    if (bucket.disabled) return t("limitOff", { window });
                    if (bucket.left !== null && bucket.left !== undefined) {
                        return t("limitLeft", { window, left: bucket.left });
                    }
                    if (bucket.amount !== null && bucket.amount !== undefined) {
                        return t("limitAmount", {
                            window,
                            amount: bucket.amount,
                        });
                    }
                    return t("limitUnknown", { window });
                });
                return {
                    key: group.key,
                    line: t("groupLine", {
                        group: group.name,
                        limits: limits.join(" · "),
                    }),
                    description: group.description || "",
                };
            });
        },
        hintText() {
            const hint = HINTS[this.problem];
            return hint ? this.$t(`AntigravityUsage.UI.${hint}`) : "";
        },
    },
    methods: {
        async check() {
            const t = (key, params) =>
                this.$t(`AntigravityUsage.UI.${key}`, params);
            this.statusText = t("checking");
            this.problem = null;
            try {
                const response = await this.$fd.sendToBackend({
                    data: "usage-status",
                    settings: this.modelValue.data,
                    cid: CID,
                });
                if (response && response.success) {
                    this.reply = response;
                    const server = t(
                        response.server === "ide" ? "serverIde" : "serverApp"
                    );
                    this.statusText = response.tier
                        ? t("connectedTier", { server, tier: response.tier })
                        : t("connectedVia", { server });
                } else {
                    this.problem = (response && response.problem) || null;
                    // the backend's error text is English: word it here
                    const key =
                        PROBLEMS[this.problem] ||
                        CODES[response && response.code];
                    this.statusText = t("notAvailable", {
                        error: key
                            ? t(key)
                            : (response && response.error) || "?",
                    });
                }
            } catch (error) {
                this.statusText = "";
            }
        },
    },
    mounted() {
        const data = this.modelValue.data;
        if (data.metric === undefined || data.metric === null) data.metric = "";
        if (data.showResetTime === undefined) data.showResetTime = true;
        if (data.showMark === undefined) data.showMark = true;
        // key texts follow the FlexDesigner language until changed here
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
        this.check();
    },
};
</script>

<style scoped></style>
