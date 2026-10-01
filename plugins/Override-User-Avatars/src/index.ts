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

type Config = { enabled: boolean; targetUserId: string; imageUrl: string; debug: boolean };

function config(): Config | null {
    const targetUserId = String(storage.targetUserId ?? "").trim();
    const imageUrl = String(storage.imageUrl ?? "").trim();
    let parsed: URL;

    if (storage.enabled === false || !SNOWFLAKE.test(targetUserId)) return null;
    try {
        parsed = new URL(imageUrl);
    } catch {
        return null;
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") return null;

    const cached = storage.cachedImageSourceUrl === parsed.href &&
        typeof storage.cachedImageDataUrl === "string" && storage.cachedImageDataUrl.startsWith("data:image/")
        ? storage.cachedImageDataUrl
        : null;
    // Never render the remote URL repeatedly. Replacement starts after the one-time cache succeeds.
    if (!cached) return null;
    return { enabled: true, targetUserId, imageUrl: cached, debug: storage.debug === true };
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

export async function cacheConfiguredImage(force = false): Promise<void> {
    const rawUrl = String(storage.imageUrl ?? "").trim();
    let url: URL;
    try {
        url = new URL(rawUrl);
        if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("Only HTTP(S) URLs are supported");
    } catch {
        setRuntimeStatus("Image cache failed: enter a valid HTTP(S) image URL.");
        return;
    }
    if (!force && storage.cachedImageSourceUrl === url.href && storage.cachedImageDataUrl) return;
    if (cacheInFlight) return;

    cacheInFlight = true;
    setRuntimeStatus("Downloading the configured image once for local reuse…");
    try {
        const response = await fetch(url.href);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const contentType = (response.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
        if (!contentType.startsWith("image/")) throw new Error(`not an image (${contentType || "unknown type"})`);
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!bytes.length) throw new Error("empty image");
        if (bytes.length > MAX_IMAGE_BYTES) throw new Error("image exceeds 5 MiB");
        // Persist a data URL in plugin storage. Rendering it no longer contacts the image host.
        storage.cachedImageDataUrl = `data:${contentType};base64,${bytesToBase64(bytes)}`;
        storage.cachedImageSourceUrl = url.href;
        setRuntimeStatus(`${loaded ? "Active" : "Cached while disabled"}: image cached locally (${Math.ceil(bytes.length / 1024)} KiB).`);
        console.log(`${TAG} cached configured image locally (${bytes.length} bytes)`);
        if (loaded) refreshClient();
    } catch (error) {
        setRuntimeStatus(`Image cache failed: ${error instanceof Error ? error.message : String(error)}`);
        console.log(`${TAG} could not cache configured image`, error);
    } finally {
        cacheInFlight = false;
    }
}

function isKnownChannelId(id: string): boolean {
    try {
        return Boolean(findByStoreName("ChannelStore")?.getChannel(id));
    } catch {
        return false;
    }
}

export function getConfigurationStatus(): string {
    const targetUserId = String(storage.targetUserId ?? "").trim();
    const imageUrl = String(storage.imageUrl ?? "").trim();
    if (!SNOWFLAKE.test(targetUserId)) return "Enter the target person's User ID (not a channel/server ID).";
    if (isKnownChannelId(targetUserId)) return "This is a Channel ID. Long-press the person's profile and copy their User ID.";
    try {
        const parsed = new URL(imageUrl);
        if (parsed.protocol !== "https:" && parsed.protocol !== "http:") throw new Error();
    } catch {
        return "Enter a complete http:// or https:// image URL.";
    }
    if (storage.enabled === false) return "Configured, but currently disabled.";
    if (storage.cachedImageSourceUrl !== new URL(imageUrl).href || !storage.cachedImageDataUrl) {
        return "URL is valid but not cached yet. Tap Download / Refresh local image.";
    }
    return "Configuration looks valid. Tap Test / Refresh, then reopen a view containing that user.";
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
        const current = config();
        if (!current || !args.some((arg: unknown) => argumentIdentifiesTarget(arg, current.targetUserId))) {
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
        const current = config();
        const props = args[0];
        if (!current || !objectContainsTargetUser(props, current.targetUserId)) return original(...args);

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
    const targetUserId = String(storage.targetUserId ?? "").trim();
    if (!SNOWFLAKE.test(targetUserId)) {
        console.log(`${TAG} refresh skipped: enter the target person's User ID, not a channel ID`);
        return;
    }
    if (isKnownChannelId(targetUserId)) {
        console.log(`${TAG} refresh skipped: configured ID belongs to a channel; copy the person's User ID instead`);
        return;
    }
    if (!config() && storage.enabled !== false) {
        console.log(`${TAG} no matching local image cache; starting the one-time download`);
        void cacheConfiguredImage(false);
        return;
    }
    try {
        const user = findByStoreName("UserStore")?.getUser(targetUserId);
        if (!user) return logOnce("refresh:no-user", "target is not currently present in UserStore");
        FluxDispatcher.dispatch({ type: "USER_UPDATE", user });
        console.log(`${TAG} requested local UI refresh`);
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
        setRuntimeStatus(`Loaded: ${unpatches.length} avatar hook(s) installed${storage.cachedImageDataUrl ? "; local image cache available" : ""}.`);
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
    void cacheConfiguredImage(false);
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
