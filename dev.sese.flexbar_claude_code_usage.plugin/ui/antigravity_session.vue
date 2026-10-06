<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-select
                    v-model="modelValue.data.source"
                    :items="sourceOptions"
                    :label="$t('AntigravitySession.UI.source')"
                    :hint="$t('AntigravitySession.UI.sourceHint')"
                    persistent-hint
                    item-title="title"
                    item-value="value"
                    outlined
                    class="mx-2"
                    @update:model-value="scheduleCheck"
                ></v-select>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <v-text-field
                    v-model="modelValue.data.projectFilter"
                    :label="$t('AntigravitySession.UI.projectFilter')"
                    :hint="$t('AntigravitySession.UI.projectFilterHint')"
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
                <v-text-field
                    v-model.number="modelValue.data.idleMinutes"
                    :label="$t('AntigravitySession.UI.idleMinutes')"
                    type="number"
                    min="1"
                    placeholder="15"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-text-field>
            </v-col>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('AntigravitySession.UI.lang')"
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
                    :label="$t('AntigravitySession.UI.showProject')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('AntigravitySession.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <v-switch
                    v-model="modelValue.data.showProgress"
                    :label="$t('AntigravitySession.UI.showProgress')"
                    :hint="$t('AntigravitySession.UI.showProgressHint')"
                    persistent-hint
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
// Antigravity Sessions key settings. The backend
// (src/providers/antigravity/session.ts) answers 'session-status' with what
// a key with these settings shows, or a notice. source: auto (the app, the
// IDE and the agy CLI together), app, ide or cli. OWNER: the
// antigravity-session implementer.
const CID = "dev.sese.flexbar_claude_code_usage.antigravity_session";

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
                { title: this.$t("AntigravitySession.UI.sourceAuto"), value: "auto" },
                { title: this.$t("AntigravitySession.UI.sourceApp"), value: "app" },
                { title: this.$t("AntigravitySession.UI.sourceIde"), value: "ide" },
                { title: this.$t("AntigravitySession.UI.sourceCli"), value: "cli" },
            ];
        },
    },
    methods: {
        scheduleCheck() {
            clearTimeout(this.checkTimer);
            this.checkTimer = setTimeout(() => this.check(), 600);
        },
        async check() {
            this.statusText = this.$t("AntigravitySession.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "session-status",
                    cid: CID,
                    filter: this.modelValue.data.projectFilter || "",
                    settings: this.modelValue.data,
                });
                // this page's language, not the key's
                const locale = String(this.$i18n.locale || "");
                const lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
                if (response && response.success) {
                    this.statusText = this.$t("AntigravitySession.UI.found", {
                        project: response.project || "?",
                        state: this.$t(`Session.State.${response.state}`),
                    });
                } else if (response && response.notice) {
                    this.statusText = `${response.notice.label[lang]} — ${response.notice.text[lang]}`;
                } else {
                    this.statusText = this.$t("AntigravitySession.UI.notFound", {
                        dir: (response && response.projectsDir) || "~/.gemini",
                    });
                }
            } catch (error) {
                this.statusText = "";
            }
        },
    },
    mounted() {
        const data = this.modelValue.data;
        if (data.source === undefined) data.source = "auto";
        if (data.projectFilter === undefined) data.projectFilter = "";
        if (data.idleMinutes === undefined) data.idleMinutes = 15;
        if (data.showProject === undefined) data.showProject = true;
        if (data.showMark === undefined) data.showMark = true;
        if (data.showProgress === undefined) data.showProgress = true;
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
