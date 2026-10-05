<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-text-field
                    v-model="modelValue.data.projectFilter"
                    :label="$t('KimiSession.UI.projectFilter')"
                    :hint="$t('KimiSession.UI.projectFilterHint')"
                    persistent-hint
                    placeholder="my-project"
                    clearable
                    outlined
                    class="mx-2"
                    @update:model-value="scheduleCheck"
                ></v-text-field>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.source"
                    :items="sourceOptions"
                    :label="$t('KimiSession.UI.source')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                    @update:model-value="scheduleCheck"
                ></v-select>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.includeAutomations"
                    :label="$t('KimiSession.UI.includeAutomations')"
                    :disabled="modelValue.data.source === 'cli'"
                    hide-details
                    class="mx-2"
                    @update:model-value="scheduleCheck"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="6">
                <v-text-field
                    v-model.number="modelValue.data.idleMinutes"
                    :label="$t('KimiSession.UI.idleMinutes')"
                    type="number"
                    min="1"
                    placeholder="15"
                    hide-details
                    outlined
                    class="mx-2"
                    @update:model-value="scheduleCheck"
                ></v-text-field>
            </v-col>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('KimiSession.UI.lang')"
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
                    v-model="modelValue.data.showProject"
                    :label="$t('KimiSession.UI.showProject')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('KimiSession.UI.showMark')"
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
// Kimi Sessions key settings. OWNER: the kimi-session implementer.
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
            checkTimer: null,
        };
    },
    computed: {
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
        sourceOptions() {
            return [
                { title: this.$t("KimiSession.UI.sourceAuto"), value: "auto" },
                { title: this.$t("KimiSession.UI.sourceDesktop"), value: "desktop" },
                { title: this.$t("KimiSession.UI.sourceCli"), value: "cli" },
            ];
        },
    },
    methods: {
        scheduleCheck() {
            clearTimeout(this.checkTimer);
            this.checkTimer = setTimeout(() => this.check(), 600);
        },
        async check() {
            this.statusText = this.$t("KimiSession.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "session-status",
                    cid: "dev.sese.flexbar_claude_code_usage.kimi_session",
                    filter: this.modelValue.data.projectFilter || "",
                    settings: this.modelValue.data,
                });
                // this page's language, not the key's
                const locale = String(this.$i18n.locale || "");
                const lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
                if (response && response.success) {
                    this.statusText = this.$t("KimiSession.UI.found", {
                        project: response.project || "?",
                        state: this.$t(`Session.State.${response.state}`),
                    });
                } else if (response && response.notice) {
                    this.statusText = `${response.notice.label[lang]} — ${response.notice.text[lang]}`;
                } else {
                    this.statusText = this.$t("KimiSession.UI.notFound", {
                        dir: (response && response.projectsDir) || "~/.kimi-code/sessions",
                    });
                }
            } catch (error) {
                this.statusText = "";
            }
        },
    },
    mounted() {
        const data = this.modelValue.data;
        if (data.projectFilter === undefined) data.projectFilter = "";
        if (data.source === undefined) data.source = "auto";
        if (data.includeAutomations === undefined) data.includeAutomations = false;
        if (data.idleMinutes === undefined) data.idleMinutes = 15;
        if (data.showProject === undefined) data.showProject = true;
        if (data.showMark === undefined) data.showMark = true;
        // key text follows the FlexDesigner language until changed here
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
        this.check();
    },
    beforeUnmount() {
        clearTimeout(this.checkTimer);
    },
};
</script>

<style scoped></style>
