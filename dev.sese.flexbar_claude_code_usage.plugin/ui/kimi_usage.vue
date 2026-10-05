<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.metric"
                    :items="metricOptions"
                    :label="$t('KimiUsage.UI.metric')"
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
                    :label="$t('KimiUsage.UI.lang')"
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
                    :label="$t('KimiUsage.UI.showResetTime')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('KimiUsage.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p
                    v-if="modelValue.data.metric === 'context'"
                    class="text-caption mx-2"
                >
                    {{ $t("KimiUsage.UI.contextHint") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Kimi Usage key settings. The metric list is fixed (the backend's metric ids
// in src/providers/kimi/usageApi.ts); limits only an older server reports are
// appended from the backend's reply.
const METRICS = [
    { value: "5h", key: "metric5h" },
    { value: "weekly", key: "metricWeekly" },
    { value: "monthly", key: "metricMonthly" },
    { value: "monthly_code", key: "metricMonthlyCode" },
    { value: "extra", key: "metricExtra" },
    { value: "context", key: "metricContext" },
];

// backend ProviderError codes with their own wording on this page
const ERROR_KEYS = {
    "not-installed": "errorNotInstalled",
    "not-configured": "errorNotConfigured",
    "no-credentials": "errorNoCredentials",
    unauthorized: "errorUnauthorized",
    unsupported: "errorUnsupported",
    "rate-limited": "errorRateLimited",
    network: "errorNetwork",
    http: "errorHttp",
    parse: "errorParse",
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
            metrics: [],
            statusText: "",
        };
    },
    computed: {
        metricOptions() {
            const options = [
                { title: this.$t("KimiUsage.UI.metricDefault"), value: "" },
                ...METRICS.map(m => ({
                    title: this.$t(`KimiUsage.UI.${m.key}`),
                    value: m.value,
                })),
            ];
            const known = new Set(options.map(o => o.value));
            for (const metric of this.metrics) {
                if (!known.has(metric.id)) {
                    options.push({ title: metric.label, value: metric.id });
                    known.add(metric.id);
                }
            }
            const current = this.modelValue.data.metric;
            if (current && !known.has(current)) {
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
    },
    methods: {
        async check() {
            this.statusText = this.$t("KimiUsage.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "usage-status",
                    settings: this.modelValue.data,
                    cid: "dev.sese.flexbar_claude_code_usage.kimi_usage",
                });
                if (response && response.success) {
                    this.metrics = Array.isArray(response.metrics)
                        ? response.metrics
                        : [];
                    this.statusText = response.contextOnly
                        ? this.$t("KimiUsage.UI.contextOnly")
                        : this.$t("KimiUsage.UI.connected");
                } else {
                    const key = response && ERROR_KEYS[response.code];
                    this.statusText = key
                        ? this.$t(`KimiUsage.UI.${key}`)
                        : this.$t("KimiUsage.UI.notAvailable", {
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
