<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-select
                    v-model="modelValue.data.target"
                    :items="targetOptions"
                    :label="$t('GeminiNewSession.UI.target')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
        </v-row>
        <v-row v-if="!isApp">
            <v-col cols="12">
                <v-text-field
                    v-model="modelValue.data.folder"
                    :label="$t('GeminiNewSession.UI.folder')"
                    :hint="$t('GeminiNewSession.UI.folderHint')"
                    persistent-hint
                    placeholder="~/projects/my-app"
                    clearable
                    outlined
                    class="mx-2"
                ></v-text-field>
            </v-col>
        </v-row>
        <v-row v-if="!isApp">
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.approvalMode"
                    :items="approvalOptions"
                    :label="$t('GeminiNewSession.UI.approvalMode')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.resume"
                    :label="$t('GeminiNewSession.UI.resume')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('GeminiNewSession.UI.lang')"
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
                <p class="text-caption mx-2">
                    {{ isApp ? $t("GeminiNewSession.UI.appHint") : $t("GeminiNewSession.UI.terminalHint") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Gemini New Session key settings. OWNER: the gemini-session implementer.
// target: terminal-cli (Terminal running the Gemini CLI in the folder) or
// gemini-app (a new chat in the Gemini app, no folder); resume and
// approvalMode are fixed presets passed to the CLI (no free text).
export default {
    props: {
        modelValue: {
            type: Object,
            required: true,
        },
    },
    emits: ["update:modelValue"],
    computed: {
        isApp() {
            return this.modelValue.data.target === "gemini-app";
        },
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
        targetOptions() {
            return [
                { title: this.$t("GeminiNewSession.UI.targetTerminal"), value: "terminal-cli" },
                { title: this.$t("GeminiNewSession.UI.targetApp"), value: "gemini-app" },
            ];
        },
        approvalOptions() {
            return [
                { title: this.$t("GeminiNewSession.UI.approvalDefault"), value: "default" },
                { title: this.$t("GeminiNewSession.UI.approvalAutoEdit"), value: "auto_edit" },
                { title: this.$t("GeminiNewSession.UI.approvalYolo"), value: "yolo" },
                { title: this.$t("GeminiNewSession.UI.approvalPlan"), value: "plan" },
            ];
        },
    },
    mounted() {
        const data = this.modelValue.data;
        if (data.folder === undefined || data.folder === null) data.folder = "";
        if (data.target === undefined) data.target = "terminal-cli";
        if (data.resume === undefined) data.resume = false;
        if (data.approvalMode === undefined) data.approvalMode = "default";
        // key text follows the FlexDesigner language until changed here
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
    },
};
</script>

<style scoped></style>
