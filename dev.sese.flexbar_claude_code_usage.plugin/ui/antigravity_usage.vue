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
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Antigravity Usage key settings: which limit the meter shows. The backend
// (src/providers/antigravity/usage.ts) answers 'usage-status' with the
// metrics it found, or an error. OWNER: the antigravity-usage implementer.
const CID = "dev.sese.flexbar_claude_code_usage.antigravity_usage";

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
                    title: this.$t("AntigravityUsage.UI.metricDefault"),
                    value: "",
                },
            ];
            for (const metric of this.metrics) {
                options.push({ title: metric.label, value: metric.id });
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
    },
    methods: {
        async check() {
            this.statusText = this.$t("AntigravityUsage.UI.checking");
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
                    this.statusText = this.$t("AntigravityUsage.UI.connected");
                } else {
                    this.statusText = this.$t(
                        "AntigravityUsage.UI.notAvailable",
                        { error: (response && response.error) || "?" }
                    );
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
