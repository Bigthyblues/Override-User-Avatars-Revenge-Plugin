import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { cacheConfiguredImage, getConfigurationStatus, getRuntimeStatus, refreshClient } from "./index";

const { FormDivider, FormInput, FormRow, FormSwitch } = Forms;

export default function Settings() {
    useProxy(storage);

    return (
        <ReactNative.ScrollView>
            <FormSwitch
                label="Enabled"
                value={storage.enabled !== false}
                onValueChange={(value: boolean) => { storage.enabled = value; refreshClient(); }}
            />
            <FormDivider />
            <FormRow
                label="Target User ID (not Channel ID)"
                subLabel="Enable Discord Developer Mode, open/long-press the person's profile, then use Copy User ID."
            />
            <FormInput
                placeholder="Enter a Discord user ID"
                value={storage.targetUserId || ""}
                onChange={(value: string) => (storage.targetUserId = value.trim())}
            />
            <FormDivider />
            <FormRow label="Image URL" />
            <FormInput
                placeholder="Enter an HTTP(S) image URL"
                value={storage.imageUrl || ""}
                onChange={(value: string) => (storage.imageUrl = value.trim())}
            />
            <FormDivider />
            <FormRow label="Configuration status" subLabel={getConfigurationStatus()} />
            <FormDivider />
            <FormRow label="Runtime status" subLabel={getRuntimeStatus()} />
            <FormRow
                label="Download / Refresh local image"
                subLabel="Downloads once (maximum 5 MiB) and then renders the persistent local copy."
                onPress={() => void cacheConfiguredImage(true)}
            />
            <FormDivider />
            <FormSwitch
                label="Debug logging"
                value={storage.debug === true}
                onValueChange={(value: boolean) => (storage.debug = value)}
            />
            <FormRow
                label="Test / Refresh"
                subLabel="Validate the current settings and ask Discord to redraw the cached user."
                onPress={refreshClient}
            />
        </ReactNative.ScrollView>
    );
}
