import { ReactNative } from "@vendetta/metro/common";
import { storage } from "@vendetta/plugin";
import { useProxy } from "@vendetta/storage";
import { Forms } from "@vendetta/ui/components";
import { refreshClient } from "./index";

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
