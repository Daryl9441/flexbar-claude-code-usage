<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-text-field
                    v-model="modelValue.data.projectFilter"
                    :label="$t('GrokbotSession.UI.projectFilter')"
                    :hint="$t('GrokbotSession.UI.projectFilterHint')"
                    persistent-hint
                    placeholder="Example Bot"
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
                    :label="$t('GrokbotSession.UI.idleMinutes')"
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
                    :label="$t('GrokbotSession.UI.lang')"
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
                    :label="$t('GrokbotSession.UI.showProject')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('GrokbotSession.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <v-switch
                    v-model="modelValue.data.liveDetection"
                    :label="$t('GrokbotSession.UI.liveDetection')"
                    :hint="$t('GrokbotSession.UI.liveDetectionHint')"
                    persistent-hint
                    class="mx-2"
                    @update:model-value="scheduleCheck"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p class="text-caption text-medium-emphasis mx-2">
                    {{ $t("GrokbotSession.UI.limitHint") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Grok Bot Sessions key settings. liveDetection checks that a marker or
// daemon pid still belongs to a Grok process; off shows the roster only.
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
    },
    methods: {
        scheduleCheck() {
            clearTimeout(this.checkTimer);
            this.checkTimer = setTimeout(() => this.check(), 600);
        },
        async check() {
            this.statusText = this.$t("GrokbotSession.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "session-status",
                    cid: "dev.sese.flexbar_claude_code_usage.grokbot_session",
                    filter: this.modelValue.data.projectFilter || "",
                    settings: this.modelValue.data,
                });
                const locale = String(this.$i18n.locale || "");
                const lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
                if (response && response.success) {
                    this.statusText = this.$t("GrokbotSession.UI.found", {
                        project: response.project || response.title || "Grok Bot",
                        state: this.$t(`Session.State.${response.state}`),
                    });
                } else if (response && response.notice) {
                    this.statusText = `${response.notice.label[lang]} — ${response.notice.text[lang]}`;
                } else {
                    this.statusText = this.$t("GrokbotSession.UI.notFound", {
                        dir: (response && response.projectsDir) || "Grok Bot",
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
        if (data.idleMinutes === undefined) data.idleMinutes = 15;
        if (data.showProject === undefined) data.showProject = true;
        if (data.showMark === undefined) data.showMark = true;
        if (data.liveDetection === undefined) data.liveDetection = true;
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
