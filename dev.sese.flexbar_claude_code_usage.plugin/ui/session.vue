<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-text-field
                    v-model="modelValue.data.projectFilter"
                    :label="$t('Session.UI.projectFilter')"
                    :hint="$t('Session.UI.projectFilterHint')"
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
                    :label="$t('Session.UI.idleMinutes')"
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
                    :label="$t('Session.UI.lang')"
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
                    :label="$t('Session.UI.showProject')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showClawd"
                    :label="$t('Session.UI.showClawd')"
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
            this.statusText = this.$t("Session.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "session-status",
                    filter: this.modelValue.data.projectFilter || "",
                });
                if (response && response.success) {
                    this.statusText = this.$t("Session.UI.found", {
                        project: response.project || "?",
                        state: this.$t(`Session.State.${response.state}`),
                    });
                } else {
                    this.statusText = this.$t("Session.UI.notFound", {
                        dir: (response && response.projectsDir) || "~/.claude/projects",
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
        if (data.showClawd === undefined) data.showClawd = false;
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
