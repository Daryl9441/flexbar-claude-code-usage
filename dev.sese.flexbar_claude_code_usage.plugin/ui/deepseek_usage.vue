<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.metric"
                    :items="metricOptions"
                    :label="$t('DeepseekUsage.UI.metric')"
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
                    :label="$t('DeepseekUsage.UI.lang')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('DeepseekUsage.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p
                    v-for="line in balanceLines"
                    :key="line"
                    class="text-caption mx-2"
                >
                    {{ line }}
                </p>
                <p class="text-caption text-medium-emphasis mx-2">
                    {{ $t("DeepseekUsage.UI.hintKey") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// DeepSeek Usage reads GET /user/balance with the plugin's API key.
const CID = "dev.sese.flexbar_claude_code_usage.deepseek_usage";

const ERROR_KEYS = {
    "no-credentials": "errorNoKey",
    unauthorized: "errorUnauthorized",
    "rate-limited": "errorRateLimited",
    network: "errorNetwork",
    http: "errorHttp",
    parse: "errorParse",
    unsupported: "errorUnsupported",
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
                {
                    title: this.$t("DeepseekUsage.UI.metricDefault"),
                    value: "",
                },
            ];
            const known = new Set([""]);
            for (const metric of this.metrics) {
                if (known.has(metric.id)) continue;
                options.push({
                    title: this.metricTitle(metric),
                    value: metric.id,
                });
                known.add(metric.id);
            }
            const current = this.modelValue.data.metric;
            if (current && !known.has(current)) {
                options.push({ title: current, value: current });
            }
            return options;
        },
        balanceLines() {
            return this.metrics
                .filter(metric => typeof metric.amount === "number")
                .map(metric => {
                    const amount = (Math.round(metric.amount * 100) / 100).toFixed(2);
                    const state =
                        metric.available === false
                            ? this.$t("DeepseekUsage.UI.unavailable")
                            : this.$t("DeepseekUsage.UI.available");
                    return `${this.metricTitle(metric)} ${amount} · ${state}`;
                });
        },
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
    },
    methods: {
        metricTitle(metric) {
            const currency = metric.currency || "";
            if (String(metric.id).endsWith("_granted")) {
                return this.$t("DeepseekUsage.UI.metricGranted", { currency });
            }
            if (String(metric.id).endsWith("_topped_up")) {
                return this.$t("DeepseekUsage.UI.metricToppedUp", { currency });
            }
            return this.$t("DeepseekUsage.UI.metricTotal", {
                currency: currency || metric.label,
            });
        },
        async check() {
            this.statusText = this.$t("DeepseekUsage.UI.checking");
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
                    this.statusText = this.$t("DeepseekUsage.UI.connected");
                } else {
                    this.metrics = [];
                    const name = response && ERROR_KEYS[response.code];
                    this.statusText = this.$t("DeepseekUsage.UI.notAvailable", {
                        error: name
                            ? this.$t(`DeepseekUsage.UI.${name}`)
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
