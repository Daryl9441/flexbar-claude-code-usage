<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-select
                    v-model="modelValue.data.target"
                    :items="targetOptions"
                    :label="$t('AntigravityNewSession.UI.target')"
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
                    :label="$t('AntigravityNewSession.UI.folder')"
                    :hint="$t('AntigravityNewSession.UI.folderHint')"
                    persistent-hint
                    placeholder="~/projects/my-app"
                    clearable
                    outlined
                    class="mx-2"
                ></v-text-field>
            </v-col>
        </v-row>
        <v-row v-if="usesCli">
            <v-col cols="12">
                <v-select
                    v-model="modelValue.data.mode"
                    :items="modeOptions"
                    :label="$t('AntigravityNewSession.UI.mode')"
                    item-title="title"
                    item-value="value"
                    :hint="modelValue.data.mode === 'skip-permissions' ? $t('AntigravityNewSession.UI.skipWarning') : ''"
                    :persistent-hint="modelValue.data.mode === 'skip-permissions'"
                    :hide-details="modelValue.data.mode !== 'skip-permissions'"
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
        </v-row>
        <v-row v-if="usesCli">
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.resume"
                    :label="$t('AntigravityNewSession.UI.resume')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.sandbox"
                    :label="$t('AntigravityNewSession.UI.sandbox')"
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
                <p class="text-caption mx-2">{{ hint }}</p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Antigravity New Session key settings. OWNER: the antigravity-session
// implementer. target: auto (agy when installed, else the app, else the
// IDE), terminal-cli (Terminal running agy in the folder), app (brings up
// the desktop app; ⌘N there starts a conversation, Antigravity has no link
// for it) or ide (opens the folder in the IDE). mode, resume and sandbox are
// fixed agy presets (no free text).
export default {
    props: {
        modelValue: {
            type: Object,
            required: true,
        },
    },
    emits: ["update:modelValue"],
    computed: {
        target() {
            return this.modelValue.data.target || "auto";
        },
        isApp() {
            return this.target === "app";
        },
        usesCli() {
            return this.target === "auto" || this.target === "terminal-cli";
        },
        hint() {
            switch (this.target) {
                case "terminal-cli":
                    return this.$t("AntigravityNewSession.UI.terminalHint");
                case "app":
                    return this.$t("AntigravityNewSession.UI.appHint");
                case "ide":
                    return this.$t("AntigravityNewSession.UI.ideHint");
                default:
                    return this.$t("AntigravityNewSession.UI.autoHint");
            }
        },
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
        targetOptions() {
            return [
                { title: this.$t("AntigravityNewSession.UI.targetAuto"), value: "auto" },
                { title: this.$t("AntigravityNewSession.UI.targetTerminal"), value: "terminal-cli" },
                { title: this.$t("AntigravityNewSession.UI.targetApp"), value: "app" },
                { title: this.$t("AntigravityNewSession.UI.targetIde"), value: "ide" },
            ];
        },
        modeOptions() {
            return [
                { title: this.$t("AntigravityNewSession.UI.modeDefault"), value: "default" },
                { title: this.$t("AntigravityNewSession.UI.modeAcceptEdits"), value: "accept-edits" },
                { title: this.$t("AntigravityNewSession.UI.modePlan"), value: "plan" },
                { title: this.$t("AntigravityNewSession.UI.modeSkip"), value: "skip-permissions" },
            ];
        },
    },
    mounted() {
        const data = this.modelValue.data;
        if (data.folder === undefined || data.folder === null) data.folder = "";
        if (data.target === undefined) data.target = "auto";
        if (data.mode === undefined) data.mode = "default";
        if (data.resume === undefined) data.resume = false;
        if (data.sandbox === undefined) data.sandbox = false;
        // key text follows the FlexDesigner language until changed here
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
    },
};
</script>

<style scoped></style>
