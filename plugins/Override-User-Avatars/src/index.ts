import { findByProps, findByStoreName } from "@vendetta/metro";
import { FluxDispatcher } from "@vendetta/metro/common";
import { instead } from "@vendetta/patcher";
import { storage } from "@vendetta/plugin";

const TAG = "[LocalAvatarOverride]";
const SNOWFLAKE = /^\d{15,22}$/;
const loggedPaths = new Set<string>();
let unpatches: Array<() => void> = [];

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

    return { enabled: true, targetUserId, imageUrl: parsed.href, debug: storage.debug === true };
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
    unpatches.push(instead(method, module, (args: any[], original: (...args: any[]) => any) => {
        const current = config();
        if (!current || !args.some((arg: unknown) => argumentIdentifiesTarget(arg, current.targetUserId))) {
            return original(...args);
        }

        logOnce(`replace:${method}`, `target recognized; replaced via ${method}`);
        if (current.debug) logOnce(`debug:${method}`, `${method} received a verified target argument`);
        if (method.toLowerCase().includes("source")) {
            return sourceWithUrl(original(...args), current.imageUrl);
        }
        return current.imageUrl;
    }));
    console.log(`${TAG} installed helper hook: ${method}`);
}

function patchAvatarComponent(module: Record<string, any>): void {
    if (typeof module?.Avatar !== "function") return;
    unpatches.push(instead("Avatar", module, (args: any[], original: (...args: any[]) => any) => {
        const current = config();
        const props = args[0];
        if (!current || !objectContainsTargetUser(props, current.targetUserId)) return original(...args);

        const next = { ...props };
        if ("source" in next) next.source = sourceWithUrl(next.source, current.imageUrl);
        else if ("avatarSource" in next) next.avatarSource = sourceWithUrl(next.avatarSource, current.imageUrl);
        else return original(...args);

        logOnce("replace:Avatar", "target recognized; replaced via Avatar component");
        if (current.debug) logOnce("debug:Avatar", "Avatar props contained an explicit target user association");
        return original(next, ...args.slice(1));
    }));
    console.log(`${TAG} installed component hook: Avatar`);
}

export function refreshClient(): void {
    const targetUserId = String(storage.targetUserId ?? "").trim();
    if (!SNOWFLAKE.test(targetUserId)) {
        console.log(`${TAG} refresh skipped: enter a valid Discord user ID`);
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

export function onLoad(): void {
    onUnload();
    loggedPaths.clear();
    console.log(`${TAG} loading`);

    const avatarModule = findByProps("getUserAvatarURL");
    console.log(`${TAG} avatar helper module: ${avatarModule ? "found" : "not found"}`);
    if (avatarModule) {
        for (const method of ["getUserAvatarURL", "getUserAvatarSource"]) {
            try { patchHelper(avatarModule, method); }
            catch (error) { console.log(`${TAG} could not install helper hook: ${method}`, error); }
        }
    }

    // Discord 347 has call sites which render Avatar directly instead of using the helpers.
    // This is deliberately scoped to the named Avatar export and never patches RN Image.
    const avatarComponentModule = findByProps("Avatar", "AvatarSizes");
    console.log(`${TAG} Avatar component module: ${avatarComponentModule ? "found" : "not found"}`);
    if (avatarComponentModule && avatarComponentModule !== avatarModule) {
        try { patchAvatarComponent(avatarComponentModule); }
        catch (error) { console.log(`${TAG} could not install Avatar component hook`, error); }
    }

    console.log(`${TAG} installed ${unpatches.length} hook(s)`);
    refreshClient();
}

export function onUnload(): void {
    for (const unpatch of unpatches.splice(0).reverse()) {
        try { unpatch(); } catch (error) { console.log(`${TAG} failed to remove a hook`, error); }
    }
    if (loggedPaths.size) console.log(`${TAG} unloaded; all hooks removed`);
    loggedPaths.clear();
}
