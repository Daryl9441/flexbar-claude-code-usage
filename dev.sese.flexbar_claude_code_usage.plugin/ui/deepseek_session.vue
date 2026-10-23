<template>
    <v-container>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('DeepseekSession.UI.lang')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
            <v-col cols="6">
                <v-switch
                    v-model="modelValue.data.showMark"
                    :label="$t('DeepseekSession.UI.showMark')"
                    hide-details
                    class="mx-2"
                ></v-switch>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="12">
                <p class="text-caption mx-2">{{ statusText }}</p>
                <p class="text-caption text-medium-emphasis mx-2">
                    {{ $t("DeepseekSession.UI.hint") }}
                </p>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
const CID = "dev.sese.flexbar_claude_code_usage.deepseek_session";

export default {
    props: {
        modelValue: {
            type: Object,
            required: true,
        },
    },
    emits: ["update:modelValue"],
    data() {
        return { statusText: "" };
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
        async check() {
            this.statusText = this.$t("DeepseekSession.UI.checking");
            try {
                const response = await this.$fd.sendToBackend({
                    data: "session-status",
                    settings: this.modelValue.data,
                    cid: CID,
                });
                const lang = this.modelValue.data.lang === "zh" ? "zh" : "en";
                const notice = response && response.notice;
                this.statusText =
                    notice && notice.label && notice.text
                        ? `${notice.label[lang]} — ${notice.text[lang]}`
                        : this.$t("DeepseekSession.UI.none");
            } catch (error) {
                this.statusText = "";
            }
        },
    },
    mounted() {
        const data = this.modelValue.data;
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
