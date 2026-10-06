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
                        <p class="text-subtitle-2 mt-2">Claude</p>
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
                            v-model="modelValue.config.claudeDir"
                            :label="$t('Config.ClaudeDir')"
                            placeholder="~/.claude"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <p class="text-subtitle-2 mt-2">Kimi</p>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.kimiDir"
                            :label="$t('Config.KimiDir')"
                            placeholder="~/.kimi-code"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.kimiDesktopDir"
                            :label="$t('Config.KimiDesktopDir')"
                            placeholder="~/Library/Application Support/kimi-desktop"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-switch
                            v-model="modelValue.config.kimiRefreshLogin"
                            :label="$t('Config.KimiRefreshLogin')"
                            hide-details
                        ></v-switch>
                        <p class="text-caption text-medium-emphasis">
                            {{ $t("Config.KimiRefreshLoginHint") }}
                        </p>
                    </v-col>
                    <v-col cols="12">
                        <p class="text-subtitle-2 mt-2">Gemini</p>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.geminiDir"
                            :label="$t('Config.GeminiDir')"
                            placeholder="~/.gemini"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.geminiPath"
                            :label="$t('Config.GeminiPath')"
                            placeholder="/opt/homebrew/bin/gemini"
                            outlined
                            hide-details
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.geminiCloudProject"
                            :label="$t('Config.GeminiCloudProject')"
                            :hint="$t('Config.GeminiCloudProjectHint')"
                            persistent-hint
                            outlined
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <p class="text-subtitle-2 mt-2">Antigravity</p>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.antigravityDir"
                            :label="$t('Config.AntigravityDir')"
                            :hint="$t('Config.AntigravityDirHint')"
                            placeholder="~/.gemini"
                            persistent-hint
                            outlined
                        ></v-text-field>
                    </v-col>
                    <v-col cols="12">
                        <v-text-field
                            v-model="modelValue.config.antigravityPath"
                            :label="$t('Config.AntigravityPath')"
                            placeholder="~/.local/bin/agy"
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
                <span class="ml-2">Claude Code: {{
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
        // on unless turned off (the backend reads a missing value as on)
        if (this.modelValue.config.kimiRefreshLogin === undefined) {
            this.modelValue.config.kimiRefreshLogin = true;
        }
        this.testConnection();
    },
};
</script>

<style scoped></style>
