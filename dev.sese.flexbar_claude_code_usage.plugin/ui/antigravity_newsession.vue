<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('AntigravityNewSession.UI.lang')"
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
                <p class="text-caption mx-2">{{ $t('AntigravityNewSession.UI.appHint') }}</p>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <v-btn :loading="testing" :disabled="testing" @click="testSession" class="mx-2">
                    {{ $t('AntigravityNewSession.UI.testSession') }}
                </v-btn>
                <p class="text-caption mx-2">{{ testStatus }}</p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Existing settings stay stored; the launcher maps old targets to the App.
export default {
    props: {
        modelValue: {
            type: Object,
            required: true,
        },
    },
    emits: ["update:modelValue"],
    data() { return { testing: false, testStatus: "" }; },
    computed: {
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
    },
    methods: {
        async testSession() {
            this.testing = true;
            this.testStatus = "";
            try {
                const response = await this.$fd.sendToBackend({
                    data: "new-session-test",
                    cid: "dev.sese.flexbar_claude_code_usage.antigravity_newsession",
                    settings: this.modelValue.data,
                });
                const lang = String(this.$i18n.locale || "").toLowerCase().startsWith("zh") ? "zh" : "en";
                this.testStatus = response?.success
                    ? this.$t("AntigravityNewSession.UI.testOpened")
                    : response?.error?.[lang] || this.$t("AntigravityNewSession.UI.testFailed");
            } catch {
                this.testStatus = this.$t("AntigravityNewSession.UI.testFailed");
            } finally {
                this.testing = false;
            }
        },
    },
    mounted() {
        const data = this.modelValue.data;
        // Key text follows the FlexDesigner language until changed here.
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
    },
};
</script>

<style scoped></style>
