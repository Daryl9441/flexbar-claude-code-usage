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
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Gemini Usage key settings. OWNER: the gemini-usage implementer.
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
                { title: this.$t("GeminiUsage.UI.metricDefault"), value: "" },
            ];
            for (const metric of this.metrics) {
                options.push({ title: metric.label, value: metric.id });
            }
            const current = this.modelValue.data.metric;
            if (current && !this.metrics.some(m => m.id === current)) {
                options.push({ title: current, value: current });
            }
            return options;
        },
    },
    methods: {
        async check() {
            this.statusText = this.$t("GeminiUsage.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "usage-status",
                    cid: "dev.sese.flexbar_claude_code_usage.gemini_usage",
                });
                if (response && response.success) {
                    this.metrics = Array.isArray(response.metrics)
                        ? response.metrics
                        : [];
                    this.statusText = this.$t("GeminiUsage.UI.connected");
                } else {
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
