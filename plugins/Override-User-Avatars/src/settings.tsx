import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { cacheConfiguredImages, getConfigurationStatus, getRuntimeStatus, refreshClient } from "./index";

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
            <FormDivider />
            <FormRow label="User ID" />
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
            <FormRow
                label="Additional user overrides"
                subLabel="One per line: USER_ID | IMAGE_URL"
            />
            <FormInput
                placeholder={"123456789012345678 | https://example.com/avatar.png\n…"}
                value={storage.additionalOverrides || ""}
                multiline={true}
                numberOfLines={5}
                onChange={(value: string) => (storage.additionalOverrides = value)}
            />
            <FormDivider />
            <FormRow label="Configuration status" subLabel={getConfigurationStatus()} />
            <FormDivider />
            <FormRow label="Runtime status" subLabel={getRuntimeStatus()} />
            <FormRow
                label="Download / Refresh local images"
                subLabel="Downloads once (maximum 5 MiB) and then renders the persistent local copy."
                onPress={() => void cacheConfiguredImages(true)}
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
