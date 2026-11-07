import { type Infer, v } from "convex/values";

export type { Primitive } from "./lib/primitive.js";
export { primitive } from "./lib/primitive.js";

// Latitudes are in degrees.
export const latitude = v.number();
export type Latitude = Infer<typeof latitude>;

// Longitudes are in degrees.
export const longitude = v.number();
export type Longitude = Infer<typeof longitude>;

export const point = v.object({
	latitude,
	longitude,
});
export type Point = Infer<typeof point>;

export function pointToArray(p: Point): [number, number] {
	return [p.latitude, p.longitude];
}

export const rectangle = v.object({
	west: longitude,
	east: longitude,
	south: latitude,
	north: latitude,
});
export type Rectangle = Infer<typeof rectangle>;

export type Meters = number;
export type ChordAngle = number;
