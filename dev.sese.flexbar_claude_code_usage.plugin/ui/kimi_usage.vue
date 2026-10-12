<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    :model-value="modelValue.data.metric"
                    @update:model-value="pickMetric"
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
                <p v-if="membershipText" class="text-caption mx-2">
                    {{ membershipText }}
                </p>
                <p v-if="substituteText" class="text-caption mx-2">
                    {{ substituteText }}
                </p>
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
// Membership remaining uses the monthly total (Kimi + Code). It stays
// selectable when that total is missing; Code-only limits cannot replace it.
// Other limits retain the backend's plan availability and substitution rules.
const METRICS = [
    { value: "membership", key: "metricMembership" },
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
            // ids the account reports, or null until the backend answered
            // with plan limits (not logged in, errors: nothing is marked)
            reported: null,
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
            if (!this.reported) return options;
            return options.map(option => {
                const value = option.value;
                if (value === "" || this.reported.includes(value)) {
                    return option;
                }
                if (value === "membership") {
                    return this.reported.includes("monthly")
                        ? option
                        : {
                              ...option,
                              title: this.$t("KimiUsage.UI.metricNoMembership", {
                                  metric: option.title,
                              }),
                          };
                }
                // the Kimi Work context comes from the desktop app, not the
                // plan: it may appear later, so it stays selectable
                if (value === "context") {
                    return {
                        ...option,
                        title: this.$t("KimiUsage.UI.metricNoContext", {
                            metric: option.title,
                        }),
                    };
                }
                // extra usage needs the booster wallet turned on and something
                // bought, not another plan: it stays selectable too
                if (value === "extra") {
                    return {
                        ...option,
                        title: this.$t("KimiUsage.UI.metricNoExtra", {
                            metric: option.title,
                        }),
                    };
                }
                return {
                    ...option,
                    title: this.$t("KimiUsage.UI.metricNotOnPlan", {
                        metric: option.title,
                    }),
                    props: { disabled: value !== current },
                };
            });
        },
        membershipText() {
            const current = this.modelValue.data.metric;
            if (current === "monthly") {
                return this.metrics.length > 0 &&
                    !this.metrics.some(m => m.id === "monthly")
                    ? this.$t("KimiUsage.UI.membershipUnavailable")
                    : "";
            }
            if (current && current !== "membership") return "";
            const total = this.metrics.find(m => m.id === "monthly");
            if (total && Number.isFinite(total.percent)) {
                const used = Math.min(100, Math.max(0, total.percent));
                return this.$t("KimiUsage.UI.membershipRemaining", {
                    percent: Math.round((100 - used) * 100) / 100,
                });
            }
            return this.$t(
                this.metrics.length > 0 &&
                    !this.metrics.some(m => m.id === "monthly")
                    ? "KimiUsage.UI.membershipUnavailable"
                    : "KimiUsage.UI.membershipHint"
            );
        },
        // the limit a key set to an unavailable plan limit shows instead
        substituteText() {
            const current = this.modelValue.data.metric;
            if (
                !this.reported ||
                !current ||
                current === "membership" ||
                current === "monthly" ||
                current === "context"
            ) {
                return "";
            }
            if (this.reported.includes(current)) return "";
            const fallback = this.metrics.find(m => m.id !== "context");
            if (!fallback) return "";
            const known = METRICS.find(m => m.value === fallback.id);
            return this.$t(
                current === "extra"
                    ? "KimiUsage.UI.substituteHintExtra"
                    : "KimiUsage.UI.substituteHint",
                {
                    limit: known
                        ? this.$t(`KimiUsage.UI.${known.key}`)
                        : fallback.label,
                }
            );
        },
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
    },
    methods: {
        // Vuetify's type-ahead (typing a letter while the field has focus)
        // also picks disabled options; a click cannot. Ignore those picks.
        pickMetric(value) {
            const option = this.metricOptions.find(o => o.value === value);
            if (option && option.props && option.props.disabled) return;
            this.modelValue.data.metric = value;
        },
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
                    const plan = this.metrics.filter(m => m.id !== "context");
                    this.reported =
                        !response.contextOnly && plan.length > 0
                            ? this.metrics.map(m => m.id)
                            : null;
                    this.statusText = response.contextOnly
                        ? this.$t("KimiUsage.UI.contextOnly")
                        : this.$t("KimiUsage.UI.connected");
                } else {
                    this.reported = null;
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
        if (data.metric === undefined || data.metric === null) {
            data.metric = "membership";
        }
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
