<template>
    <v-container>
        <v-row>
            <v-col cols="12">
                <v-text-field
                    v-model="modelValue.data.folder"
                    :label="$t('KimiNewSession.UI.folder')"
                    :hint="$t('KimiNewSession.UI.folderHint')"
                    persistent-hint
                    placeholder="~/projects/my-app"
                    clearable
                    outlined
                    class="mx-2"
                ></v-text-field>
            </v-col>
        </v-row>
        <v-row>
            <v-col cols="6">
                <v-select
                    v-model="modelValue.data.lang"
                    :items="langOptions"
                    :label="$t('KimiNewSession.UI.lang')"
                    item-title="title"
                    item-value="value"
                    hide-details
                    outlined
                    class="mx-2"
                ></v-select>
            </v-col>
        </v-row>
    </v-container>
</template>

<script>
// Kimi New Session key settings. OWNER: the kimi-session implementer.
export default {
    props: {
        modelValue: {
            type: Object,
            required: true,
        },
    },
    emits: ["update:modelValue"],
    computed: {
        langOptions() {
            return [
                { title: "English", value: "en" },
                { title: "简体中文", value: "zh" },
            ];
        },
    },
    mounted() {
        const data = this.modelValue.data;
        if (data.folder === undefined || data.folder === null) data.folder = "";
        // key text follows the FlexDesigner language until changed here
        if (data.lang === undefined) {
            const locale = String(this.$i18n.locale || "");
            data.lang = locale.toLowerCase().startsWith("zh") ? "zh" : "en";
        }
    },
};
</script>

<style scoped></style>
