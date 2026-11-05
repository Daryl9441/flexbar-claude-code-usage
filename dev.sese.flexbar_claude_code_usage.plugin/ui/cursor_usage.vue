<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.metric"
                    :items="metricOptions"
                    :label="$t('CursorUsage.UI.metric')"
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
                    :label="$t('CursorUsage.UI.lang')"
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
                    :label="$t('CursorUsage.UI.showResetTime')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('CursorUsage.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p class="text-caption text-medium-emphasis mx-2">
                    {{ hintText || $t("CursorUsage.UI.hintAccount") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Cursor Usage key settings. The backend answers 'usage-status' with the
// included-plan percentage, or a problem code when there is nothing to meter.
const CID = "dev.sese.flexbar_claude_code_usage.cursor_usage";

const PROBLEMS = {
    "not-installed": "problemNotInstalled",
    "not-signed-in": "problemSignedOut",
    "login-expired": "problemExpired",
    "keychain-blocked": "problemKeychain",
    "login-unreadable": "problemUnusable",
    "state-unreadable": "problemUnreadable",
    pooled: "problemPooled",
    "no-allowance": "problemNoAllowance",
    parse: "problemParse",
    network: "problemNetwork",
    http: "problemHttp",
    "rate-limited": "problemRateLimited",
};

const HINTS = {
    "not-installed": "CursorUsage.UI.hintInstall",
    "not-signed-in": "CursorUsage.UI.hintAccount",
    "login-expired": "CursorUsage.UI.hintAccount",
    pooled: "CursorUsage.UI.hintPooled",
    "no-allowance": "CursorUsage.UI.hintNoAllowance",
};

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
            statusText: "",
            problem: null,
            planLabel: null,
        };
    },
    computed: {
        metricOptions() {
            return [
                { title: this.$t("CursorUsage.UI.metricIncluded"), value: "" },
                { title: this.$t("CursorUsage.UI.metricAuto"), value: "auto" },
                { title: this.$t("CursorUsage.UI.metricApi"), value: "api" },
                {
                    title: this.$t("CursorUsage.UI.metricOndemand"),
                    value: "ondemand",
                },
            ];
        },
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
        hintText() {
            const key = HINTS[this.problem];
            return key ? this.$t(key) : "";
        },
    },
    methods: {
        async check() {
            this.statusText = this.$t("CursorUsage.UI.checking");
            this.problem = null;
            this.planLabel = null;
            try {
                const response = await this.$fd.sendToBackend({
                    data: "usage-status",
                    settings: this.modelValue.data,
                    cid: CID,
                });
                if (response && response.success) {
                    const metrics = Array.isArray(response.metrics)
                        ? response.metrics
                        : [];
                    const metric =
                        metrics.find(item => item.id === "included") ||
                        metrics[0];
                    this.planLabel = response.planLabel || null;
                    this.statusText = this.$t("CursorUsage.UI.connected", {
                        percent: metric ? metric.percent : "?",
                        plan:
                            response.planLabel ||
                            this.$t("CursorUsage.UI.planUnknown"),
                    });
                } else {
                    this.problem = (response && response.problem) || null;
                    const key = PROBLEMS[this.problem];
                    this.statusText = this.$t("CursorUsage.UI.notAvailable", {
                        error: key
                            ? this.$t(`CursorUsage.UI.${key}`)
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
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
        this.check();
    },
};
</script>

<style scoped></style>
