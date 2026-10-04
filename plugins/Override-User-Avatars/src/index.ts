import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

const TAG = "[LocalAvatarOverride]";
const SNOWFLAKE = /^\d{15,22}$/;
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const RETRY_INTERVAL_MS = 1_000;
const MAX_DISCOVERY_ATTEMPTS = 20;
const loggedPaths = new Set<string>();
let unpatches: Array<() => void> = [];
let discoveryTimer: ReturnType<typeof setTimeout> | undefined;
let discoveryAttempts = 0;
let loaded = false;
let cacheInFlight = false;
const patchedMethods = new WeakMap<object, Set<string>>();

type Rule = { targetUserId: string; remoteUrl: string };
type Config = { targetUserId: string; imageUrl: string; debug: boolean };

function validHttpUrl(value: string): string | null {
    try {
        const parsed = new URL(value.trim());
        return parsed.protocol === "https:" || parsed.protocol === "http:" ? parsed.href : null;
    } catch {
        return null;
    }
}

function configuredRules(): { rules: Rule[]; errors: string[] } {
    const candidates: Array<{ id: string; url: string; label: string }> = [{
        id: String(storage.targetUserId ?? "").trim(),
        url: String(storage.imageUrl ?? "").trim(),
        label: "Primary override",
    }];
    String(storage.additionalOverrides ?? "").split(/\r?\n/).forEach((line, index) => {
        if (!line.trim()) return;
        const match = line.match(/^\s*(\d+)\s*[|=,]\s*(\S+)\s*$/);
        candidates.push({ id: match?.[1] ?? "", url: match?.[2] ?? "", label: `Additional line ${index + 1}` });
    });

    const rules = new Map<string, Rule>();
    const errors: string[] = [];
    for (const candidate of candidates) {
        if (!candidate.id && !candidate.url && candidate.label === "Primary override") continue;
        const remoteUrl = validHttpUrl(candidate.url);
        if (!SNOWFLAKE.test(candidate.id)) errors.push(`${candidate.label}: invalid User ID`);
        else if (!remoteUrl) errors.push(`${candidate.label}: invalid HTTP(S) URL`);
        else rules.set(candidate.id, { targetUserId: candidate.id, remoteUrl });
    }
    return { rules: [...rules.values()], errors };
}

function cachedImages(): Record<string, string> {
    const result = storage.cachedImages && typeof storage.cachedImages === "object" ? storage.cachedImages : {};
    // Read the v2.1 single-image cache without requiring users to download it again.
    if (storage.cachedImageSourceUrl && storage.cachedImageDataUrl && !result[storage.cachedImageSourceUrl]) {
        result[storage.cachedImageSourceUrl] = storage.cachedImageDataUrl;
    }
    return result;
}

function configs(): Config[] {
    if (storage.enabled === false) return [];
    const cache = cachedImages();
    return configuredRules().rules.flatMap((rule) => {
        const imageUrl = cache[rule.remoteUrl];
        return typeof imageUrl === "string" && imageUrl.startsWith("data:image/")
            ? [{ targetUserId: rule.targetUserId, imageUrl, debug: storage.debug === true }]
            : [];
    });
}

function setRuntimeStatus(status: string): void {
    storage.runtimeStatus = status;
    storage.runtimeStatusAt = new Date().toISOString();
}

function bytesToBase64(bytes: Uint8Array): string {
    const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let output = "";
    for (let index = 0; index < bytes.length; index += 3) {
        const a = bytes[index];
        const b = bytes[index + 1];
        const c = bytes[index + 2];
        output += alphabet[a >> 2];
        output += alphabet[((a & 3) << 4) | ((b ?? 0) >> 4)];
        output += index + 1 < bytes.length ? alphabet[((b & 15) << 2) | ((c ?? 0) >> 6)] : "=";
        output += index + 2 < bytes.length ? alphabet[c & 63] : "=";
    }
    return output;
}

export async function cacheConfiguredImages(force = false): Promise<void> {
    const { rules, errors } = configuredRules();
    if (errors.length || !rules.length) {
        setRuntimeStatus(`Image cache skipped: ${errors[0] || "add at least one valid override."}`);
        return;
    }
    if (cacheInFlight) return;

    cacheInFlight = true;
    setRuntimeStatus(`Caching images for ${rules.length} user(s)…`);
    try {
        const cache = { ...cachedImages() };
        let downloaded = 0;
        for (const remoteUrl of new Set(rules.map((rule) => rule.remoteUrl))) {
            if (!force && cache[remoteUrl]?.startsWith("data:image/")) continue;
            const response = await fetch(remoteUrl);
            if (!response.ok) throw new Error(`${remoteUrl}: HTTP ${response.status}`);
            const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
            if (!contentType.startsWith("image/")) throw new Error(`${remoteUrl}: not an image (${contentType || "unknown type"})`);
            const bytes = new Uint8Array(await response.arrayBuffer());
            if (!bytes.length) throw new Error(`${remoteUrl}: empty image`);
            if (bytes.length > MAX_IMAGE_BYTES) throw new Error(`${remoteUrl}: image exceeds 5 MiB`);
            cache[remoteUrl] = `data:${contentType};base64,${bytesToBase64(bytes)}`;
            // Commit each successful image so a later URL failure does not discard earlier downloads.
            storage.cachedImages = { ...cache };
            downloaded += 1;
        }
        storage.cachedImages = cache;
        setRuntimeStatus(`${loaded ? "Active" : "Cached while disabled"}: ${rules.length} user override(s) ready locally.`);
        console.log(`${TAG} local image cache ready for ${rules.length} user(s); downloaded ${downloaded}`);
        if (loaded) refreshClient();
    } catch (error) {
        setRuntimeStatus(`Image cache failed: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`${TAG} could not cache configured image`, error);
    } finally {
        cacheInFlight = false;
    }
}

/** Backward-compatible export for settings bundles that imported the v2.1 name. */
export const cacheConfiguredImage = cacheConfiguredImages;

function isKnownChannelId(id: string): boolean {
    try {
        return Boolean(findByStoreName("ChannelStore")?.getChannel(id));
    } catch {
        return false;
    }
}

export function getConfigurationStatus(): string {
    const { rules, errors } = configuredRules();
    if (errors.length) return errors[0];
    if (!rules.length) return "Add at least one User ID and image URL.";
    const channelRule = rules.find((rule) => isKnownChannelId(rule.targetUserId));
    if (channelRule) return `${channelRule.targetUserId} is a Channel ID; copy that person's User ID.`;
    if (storage.enabled === false) return "Configured, but currently disabled.";
    const ready = configs().length;
    if (ready !== rules.length) return `${rules.length - ready} of ${rules.length} override(s) need Download / Refresh local images.`;
    return `${rules.length} override(s) configured and cached locally.`;
}

export function getRuntimeStatus(): string {
    return String(storage.runtimeStatus || "Plugin has not reported its runtime state yet.");
}

function logOnce(path: string, message: string): void {
    if (loggedPaths.has(path)) return;
    loggedPaths.add(path);
    console.log(`${TAG} ${message}`);
}

function decoded(value: string): string {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
}

/** Only accepts URLs whose Discord CDN path actually embeds the configured user ID. */
function discordAvatarUrlBelongsTo(value: unknown, userId: string): boolean {
    if (typeof value !== "string") return false;
    const candidate = decoded(decoded(value));
    return new RegExp(`(?:/avatars/${userId}/|/users/${userId}/avatars/)`).test(candidate);
}

function objectContainsTargetUser(value: unknown, userId: string): boolean {
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, any>;
    if (item.user?.id === userId || item.author?.id === userId || item.member?.user?.id === userId) return true;
    if (item.userId === userId || item.user_id === userId) return true;
    return false;
}

function argumentIdentifiesTarget(value: unknown, userId: string): boolean {
    if (typeof value === "string") return value === userId || discordAvatarUrlBelongsTo(value, userId);
    if (!value || typeof value !== "object") return false;
    const item = value as Record<string, any>;
    // An `id` is trusted here because helper APIs receive User objects as their primary argument.
    return item.id === userId || objectContainsTargetUser(item, userId) ||
        discordAvatarUrlBelongsTo(item.uri, userId) || discordAvatarUrlBelongsTo(item.url, userId);
}

function sourceWithUrl(source: any, imageUrl: string): any {
    if (typeof source === "string") return imageUrl;
    if (Array.isArray(source)) return source.map((entry, index) => index === 0 ? sourceWithUrl(entry, imageUrl) : entry);
    if (source && typeof source === "object") return { ...source, uri: imageUrl };
    return { uri: imageUrl };
}

function patchHelper(module: Record<string, any>, method: string): void {
    if (typeof module?.[method] !== "function") return;
    const methods = patchedMethods.get(module) ?? new Set<string>();
    if (methods.has(method)) return;
    const removePatch = instead(method, module, (args: any[], original: (...args: any[]) => any) => {
        const current = configs().find((candidate) =>
            args.some((arg: unknown) => argumentIdentifiesTarget(arg, candidate.targetUserId)));
        if (!current) {
            return original(...args);
        }

        const firstReplacement = !loggedPaths.has(`replace:${method}`);
        logOnce(`replace:${method}`, `target recognized; replaced via ${method}`);
        if (firstReplacement) setRuntimeStatus(`Working: last replacement used ${method}.`);
        if (current.debug) logOnce(`debug:${method}`, `${method} received a verified target argument`);
        if (method.toLowerCase().includes("source")) {
            return sourceWithUrl(original(...args), current.imageUrl);
        }
        return current.imageUrl;
    });
    methods.add(method);
    patchedMethods.set(module, methods);
    unpatches.push(() => {
        removePatch();
        methods.delete(method);
    });
    console.log(`${TAG} installed helper hook: ${method}`);
}
function patchAvatarComponent(module: Record<string, any>): void {
    if (typeof module?.Avatar !== "function") return;
    const methods = patchedMethods.get(module) ?? new Set<string>();
    if (methods.has("Avatar")) return;
    const removePatch = instead("Avatar", module, (args: any[], original: (...args: any[]) => any) => {
        const props = args[0];
        const current = configs().find((candidate) => objectContainsTargetUser(props, candidate.targetUserId));
        if (!current) return original(...args);

        const next = { ...props };
        if ("source" in next) next.source = sourceWithUrl(next.source, current.imageUrl);
        else if ("avatarSource" in next) next.avatarSource = sourceWithUrl(next.avatarSource, current.imageUrl);
        else return original(...args);

        const firstReplacement = !loggedPaths.has("replace:Avatar");
        logOnce("replace:Avatar", "target recognized; replaced via Avatar component");
        if (firstReplacement) setRuntimeStatus("Working: last replacement used the Avatar component.");
        if (current.debug) logOnce("debug:Avatar", "Avatar props contained an explicit target user association");
        return original(next, ...args.slice(1));
    });
    methods.add("Avatar");
    patchedMethods.set(module, methods);
    unpatches.push(() => {
        removePatch();
        methods.delete("Avatar");
    });
    console.log(`${TAG} installed component hook: Avatar`);
}

export function refreshClient(): void {
    const { rules, errors } = configuredRules();
    if (errors.length || !rules.length) {
        console.log(`${TAG} refresh skipped: ${errors[0] || "no valid overrides configured"}`);
        return;
    }
    const channelRule = rules.find((rule) => isKnownChannelId(rule.targetUserId));
    if (channelRule) {
        console.log(`${TAG} refresh skipped: ${channelRule.targetUserId} belongs to a channel; copy the person's User ID instead`);
        return;
    }
    if (configs().length !== rules.length && storage.enabled !== false) {
        console.log(`${TAG} one or more local image caches are missing; starting the one-time download`);
        void cacheConfiguredImages(false);
        return;
    }
    try {
        const UserStore = findByStoreName("UserStore");
        let refreshed = 0;
        for (const rule of rules) {
            const user = UserStore?.getUser(rule.targetUserId);
            if (!user) {
                logOnce(`refresh:no-user:${rule.targetUserId}`, `target ${rule.targetUserId} is not currently present in UserStore`);
                continue;
            }
            FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
            refreshed += 1;
        }
        console.log(`${TAG} requested local UI refresh for ${refreshed}/${rules.length} user(s)`);
    } catch (error) {
        console.log(`${TAG} local UI refresh was unavailable`, error);
    }
}

export { default as settings } from "./settings";

function discoverAndPatch(): void {
    if (!loaded) return;
    discoveryAttempts += 1;
    const hookCountBeforeDiscovery = unpatches.length;
    const helperModules = new Map<string, Record<string, any> | undefined>([
        ["getUserAvatarURL", findByProps("getUserAvatarURL")],
        ["getUserAvatarSource", findByProps("getUserAvatarSource")],
    ]);
    for (const [method, module] of helperModules) {
        logOnce(`discovery:${method}:${Boolean(module)}`, `${method} module: ${module ? "found" : "not found"}`);
        if (!module) continue;
        try { patchHelper(module, method); }
        catch (error) { console.log(`${TAG} could not install helper hook: ${method}`, error); }
    }

    // Discord 347 has call sites which render Avatar directly instead of using the helpers.
    // This is deliberately scoped to the named Avatar export and never patches RN Image.
    const avatarComponentModule = findByProps("Avatar", "AvatarSizes");
    logOnce(`discovery:Avatar:${Boolean(avatarComponentModule)}`, `Avatar component module: ${avatarComponentModule ? "found" : "not found"}`);
    if (avatarComponentModule) {
        try { patchAvatarComponent(avatarComponentModule); }
        catch (error) { console.log(`${TAG} could not install Avatar component hook`, error); }
    }
    if (discoveryAttempts === 1 || unpatches.length !== hookCountBeforeDiscovery) {
        const cachedCount = Object.keys(cachedImages()).length;
        setRuntimeStatus(`Loaded: ${unpatches.length} avatar hook(s) installed${cachedCount ? `; ${cachedCount} local image(s) cached` : ""}.`);
    }
    if (unpatches.length < 3 && discoveryAttempts < MAX_DISCOVERY_ATTEMPTS) {
        discoveryTimer = setTimeout(discoverAndPatch, RETRY_INTERVAL_MS);
    } else {
        console.log(`${TAG} discovery finished with ${unpatches.length} hook(s) after ${discoveryAttempts} attempt(s)`);
    }
}

export function onLoad(): void {
    onUnload();
    loaded = true;
    discoveryAttempts = 0;
    loggedPaths.clear();
    console.log(`${TAG} loading`);
    setRuntimeStatus("Loading: discovering Discord avatar modules…");
    discoverAndPatch();
    void cacheConfiguredImages(false);
    refreshClient();
}

export function onUnload(): void {
    loaded = false;
    if (discoveryTimer) clearTimeout(discoveryTimer);
    discoveryTimer = undefined;
    for (const unpatch of unpatches.splice(0).reverse()) {
        try { unpatch(); } catch (error) { console.log(`${TAG} failed to remove a hook`, error); }
    }
    if (loggedPaths.size) console.log(`${TAG} unloaded; all hooks removed`);
    storage.runtimeStatus = "Disabled/unloaded: no avatar hooks are active.";
    loggedPaths.clear();
}
