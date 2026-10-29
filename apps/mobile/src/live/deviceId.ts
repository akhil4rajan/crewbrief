import * as Crypto from "expo-crypto";
import { Platform } from "react-native";

let cached: string | null = null;

/** Identifies this device install in gateway logs for the life of the app process. */
export function deviceId(): string {
  cached ??= `${Platform.OS}-${Crypto.randomUUID().slice(0, 8)}`;
  return cached;
}
