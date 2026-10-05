<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.metric"
                    :items="metricOptions"
                    :label="$t('GeminiUsage.UI.metric')"
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
                    :label="$t('GeminiUsage.UI.showResetTime')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('GeminiUsage.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p v-if="hintText" class="text-caption mx-2">{{ hintText }}</p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Gemini Usage key settings: which limit the meter shows. The backend
// (src/providers/gemini/usage.ts) answers 'usage-status' with the metrics
// it found, the tier, or an error and the problem behind it.
const CID = "dev.sese.flexbar_claude_code_usage.gemini_usage";

// metrics that exist whenever the account reports quota
const FIXED = [
    ["pro", "GeminiUsage.UI.metricPro"],
    ["flash", "GeminiUsage.UI.metricFlash"],
    ["pooled", "GeminiUsage.UI.metricPooled"],
];

// problems (see usageText.ts) → hint below the status line
const HINTS = [
    [["cli-missing"], "GeminiUsage.UI.hintCli"],
    [
        ["logged-out", "login-expired", "creds-unreadable", "needs-setup"],
        "GeminiUsage.UI.hintRelogin",
    ],
    [["personal-unsupported"], "GeminiUsage.UI.hintPersonal"],
    [["api-key", "vertex", "other-auth"], "GeminiUsage.UI.hintLogin"],
    [["needs-project", "project-denied"], "GeminiUsage.UI.hintProject"],
];

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
            metrics: [],
            statusText: "",
            problem: null,
        };
    },
    computed: {
        metricOptions() {
            const options = [
                { title: this.$t("GeminiUsage.UI.metricDefault"), value: "" },
            ];
            for (const [value, key] of FIXED) {
                options.push({ title: this.$t(key), value });
            }
            for (const metric of this.metrics) {
                if (!String(metric.id).startsWith("model:")) continue;
                options.push({
                    title: this.$t("GeminiUsage.UI.metricModel", {
                        name: metric.label,
                    }),
                    value: metric.id,
                });
            }
            const current = this.modelValue.data.metric;
            if (current && !options.some(o => o.value === current)) {
                const name = String(current).replace(/^model:/, "");
                options.push({
                    title: this.$t("GeminiUsage.UI.metricModel", { name }),
                    value: current,
                });
            }
            return options;
        },
        hintText() {
            const hint = HINTS.find(([problems]) =>
                problems.includes(this.problem)
            );
            return hint ? this.$t(hint[1]) : "";
        },
    },
    methods: {
        async check() {
            this.statusText = this.$t("GeminiUsage.UI.checking");
            this.problem = null;
            try {
                const response = await this.$fd.sendToBackend({
                    data: "usage-status",
                    settings: this.modelValue.data,
                    cid: CID,
                });
                if (response && response.success) {
                    this.metrics = Array.isArray(response.metrics)
                        ? response.metrics
                        : [];
                    this.statusText = response.tier
                        ? this.$t("GeminiUsage.UI.connectedTier", {
                              tier: response.tier,
                          })
                        : this.$t("GeminiUsage.UI.connected");
                } else {
                    this.problem = (response && response.problem) || null;
                    this.statusText = this.$t("GeminiUsage.UI.notAvailable", {
                        error: (response && response.error) || "?",
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
        this.check();
    },
};
</script>

<style scoped></style>
