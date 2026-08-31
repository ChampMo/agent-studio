import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn/ui class helper, so components added later drop straight in. */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
