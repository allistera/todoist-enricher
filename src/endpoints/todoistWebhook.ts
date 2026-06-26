import { z } from "zod";
import type { AppContext } from "../types";

const TODOIST_SIGNATURE_HEADER = "X-Todoist-Hmac-SHA256";

const TodoistWebhookPayload = z.object({
	event_name: z.string(),
	event_data: z.record(z.string(), z.unknown()),
	initiator: z
		.object({
			id: z.string().optional(),
			email: z.string().optional(),
			full_name: z.string().optional(),
			image_id: z.string().nullable().optional(),
		})
		.passthrough()
		.optional(),
	user_id: z.string().optional(),
});

export async function todoistWebhook(c: AppContext) {
	const rawBody = await c.req.arrayBuffer();
	const signature = c.req.header(TODOIST_SIGNATURE_HEADER);
	const clientSecret = c.env.TODOIST_CLIENT_SECRET;

	if (!clientSecret) {
		console.error("TODOIST_CLIENT_SECRET is not configured");
		return c.json({ success: false, error: "Webhook is not configured" }, 500);
	}

	if (!signature) {
		return c.json({ success: false, error: "Missing Todoist signature" }, 401);
	}

	const verified = await verifyTodoistSignature({
		body: rawBody,
		clientSecret,
		signature,
	});

	if (!verified) {
		return c.json({ success: false, error: "Invalid Todoist signature" }, 401);
	}

	let json: unknown;

	try {
		json = JSON.parse(new TextDecoder().decode(rawBody));
	} catch {
		return c.json({ success: false, error: "Invalid JSON payload" }, 400);
	}

	const parsed = TodoistWebhookPayload.safeParse(json);

	if (!parsed.success) {
		return c.json({ success: false, error: "Invalid Todoist webhook payload" }, 400);
	}

	const payload = parsed.data;

	if (payload.event_name !== "item:added") {
		return c.json({
			success: true,
			handled: false,
			event_name: payload.event_name,
		});
	}

	const task = payload.event_data;

	console.log("Received new Todoist task", {
		id: task.id,
		content: task.content,
		user_id: payload.user_id,
	});

	return c.json({
		success: true,
		handled: true,
		event_name: payload.event_name,
		task,
	});
}

async function verifyTodoistSignature({
	body,
	clientSecret,
	signature,
}: {
	body: ArrayBuffer;
	clientSecret: string;
	signature: string;
}) {
	const encoder = new TextEncoder();
	const key = await crypto.subtle.importKey(
		"raw",
		encoder.encode(clientSecret),
		{ name: "HMAC", hash: "SHA-256" },
		false,
		["sign"],
	);
	const digest = await crypto.subtle.sign("HMAC", key, body);
	const expected = arrayBufferToBase64(digest);

	return timingSafeEqual(expected, signature);
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
	const bytes = new Uint8Array(buffer);
	let binary = "";

	for (const byte of bytes) {
		binary += String.fromCharCode(byte);
	}

	return btoa(binary);
}

function timingSafeEqual(left: string, right: string) {
	const leftBytes = new TextEncoder().encode(left);
	const rightBytes = new TextEncoder().encode(right);
	let mismatch = leftBytes.length ^ rightBytes.length;
	const length = Math.max(leftBytes.length, rightBytes.length);

	for (let index = 0; index < length; index++) {
		mismatch |= (leftBytes[index] ?? 0) ^ (rightBytes[index] ?? 0);
	}

	return mismatch === 0;
}
