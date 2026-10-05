<template>
    <v-container>
        <v-card prepend-icon="mdi-robot-outline" :title="$t('PluginName')">
            <v-card-text>
                <v-row>
                    <v-col cols="12">
                        <p class="text-body-2 mb-4">
                            {{ $t("Config.Description") }}
                        </p>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.credentialsPath"
                            :label="$t('Config.CredentialsPath')"
                            placeholder="~/.claude/.credentials.json"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model.number="modelValue.config.pollInterval"
                            :label="$t('Config.PollInterval')"
                            placeholder="180"
                            type="number"
                            min="60"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.claudeDir"
                            :label="$t('Config.ClaudeDir')"
                            placeholder="~/.claude"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                </v-row>
            </v-card-text>
            <v-card-actions>
                <v-icon :color="isConnected ? 'success' : 'error'">{{
                    isConnected ? "mdi-link" : "mdi-link-off"
                }}</v-icon>
                <span class="ml-2">{{
                    statusText || $t("Config.Checking")
                }}</span>
                <v-spacer></v-spacer>
                <v-btn variant="text" icon @click="saveConfig">
                    <v-icon>mdi-check-circle-outline</v-icon>
                </v-btn>
            </v-card-actions>
        </v-card>
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
    data() {
        return {
            isConnected: false,
            statusText: "",
        };
    },
    methods: {
        saveConfig() {
            this.$fd.setConfig(this.modelValue.config);
            this.$fd.showSnackbarMessage("success", this.$t("Config.Saved"));
            this.testConnection();
        },
        async testConnection() {
            try {
                const response = await this.$fd.sendToBackend({
                    data: "test-connection",
                    config: this.modelValue.config,
                });

                this.isConnected = response.success;
                this.statusText = response.success
                    ? this.$t("Config.Connected", {
                          session: response.session,
                          weekly: response.weekly,
                      })
                    : response.error || this.$t("Config.Disconnected");
            } catch (error) {
                this.isConnected = false;
                this.statusText = this.$t("Config.Disconnected");
                this.$fd.error("Connection test failed:", error);
            }
        },
    },
    mounted() {
        this.testConnection();
    },
};
</script>

<style scoped></style>
