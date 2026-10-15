<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.metric"
                    :items="metricOptions"
                    :label="$t('GrokbotUsage.UI.metric')"
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
                    :label="$t('GrokbotUsage.UI.lang')"
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
                    :label="$t('GrokbotUsage.UI.showResetTime')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('GrokbotUsage.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p class="text-caption text-medium-emphasis mx-2">
                    {{ hintText || $t("GrokbotUsage.UI.hintAccount") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Grok Bot Usage key settings. The backend answers 'usage-status' with the
// weekly allowance, or a problem code when there is nothing to meter.
const CID = "dev.sese.flexbar_claude_code_usage.grokbot_usage";

const PROBLEMS = {
    "not-installed": "problemNotInstalled",
    "not-signed-in": "problemSignedOut",
    "login-expired": "problemExpired",
    "state-unreadable": "problemUnreadable",
    pooled: "problemPooled",
    "no-allowance": "problemNoAllowance",
    parse: "problemParse",
    network: "problemNetwork",
    http: "problemHttp",
    "rate-limited": "problemRateLimited",
};

const HINTS = {
    "not-installed": "GrokbotUsage.UI.hintInstall",
    "not-signed-in": "GrokbotUsage.UI.hintAccount",
    "login-expired": "GrokbotUsage.UI.hintAccount",
    pooled: "GrokbotUsage.UI.hintPooled",
    "no-allowance": "GrokbotUsage.UI.hintNoAllowance",
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
                { title: this.$t("GrokbotUsage.UI.metricWeekly"), value: "" },
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
            this.statusText = this.$t("GrokbotUsage.UI.checking");
            this.problem = null;
            this.planLabel = null;
            try {
                const response = await this.$fd.sendToBackend({
                    data: "usage-status",
                    settings: this.modelValue.data,
                    cid: CID,
                });
                if (response && response.success) {
                    const metric =
                        Array.isArray(response.metrics) && response.metrics[0];
                    this.planLabel = response.planLabel || null;
                    this.statusText = this.$t("GrokbotUsage.UI.connected", {
                        percent: metric ? metric.percent : "?",
                        plan:
                            response.planLabel ||
                            this.$t("GrokbotUsage.UI.planUnknown"),
                    });
                } else {
                    this.problem = (response && response.problem) || null;
                    const key = PROBLEMS[this.problem];
                    this.statusText = this.$t("GrokbotUsage.UI.notAvailable", {
                        error: key
                            ? this.$t(`GrokbotUsage.UI.${key}`)
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
