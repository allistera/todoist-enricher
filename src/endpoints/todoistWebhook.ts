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

const TodoistTaskSchema = z.object({
	id: z.union([z.string(), z.number()]),
	content: z.string(),
	description: z.string().optional().nullable(),
	parent_id: z.union([z.string(), z.number()]).optional().nullable(),
	labels: z.array(z.string()).optional().nullable(),
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

	const taskParseResult = TodoistTaskSchema.safeParse(payload.event_data);
	if (!taskParseResult.success) {
		console.error("Invalid Todoist task event data:", taskParseResult.error);
		return c.json({ success: false, error: "Invalid task data inside webhook payload" }, 400);
	}

	const task = taskParseResult.data;
	const taskId = String(task.id);

	console.log("Received new Todoist task", {
		id: taskId,
		content: task.content,
		user_id: payload.user_id,
	});

	let enrichedData: { content: string; description: string; subtasks?: string[] } | null = null;

	const hasEnrichLabel = task.labels && task.labels.some(label => label.toLowerCase() === "enrich");

	if (hasEnrichLabel) {
		if (task.description && task.description.trim() !== "") {
			const openaiApiKey = c.env.OPENAI_API_KEY;
			const todoistApiToken = c.env.TODOIST_API_TOKEN;

			if (!openaiApiKey || !todoistApiToken) {
				console.warn("Skipping task enrichment because OPENAI_API_KEY or TODOIST_API_TOKEN is not configured");
			} else {
				try {
					enrichedData = await enrichTask(
						{ id: taskId, content: task.content, description: task.description },
						openaiApiKey,
						todoistApiToken
					);
				} catch (error) {
					console.error("Failed to enrich task:", error);
				}
			}
		} else {
			console.log(`Task ${taskId} has the 'Enrich' label but does not have a description; skipping enrichment.`);
		}
	} else {
		console.log(`Task ${taskId} does not have the 'Enrich' label; skipping enrichment.`);
	}

	return c.json({
		success: true,
		handled: true,
		event_name: payload.event_name,
		task: {
			id: taskId,
			content: task.content,
			description: task.description,
			parent_id: task.parent_id ? String(task.parent_id) : null,
			labels: task.labels || [],
		},
		enriched: enrichedData,
	});
}

async function enrichTask(
	task: { id: string; content: string; description: string },
	openaiApiKey: string,
	todoistApiToken: string
) {
	console.log(`Enriching task ${task.id} using ChatGPT...`);

	const response = await fetch("https://api.openai.com/v1/chat/completions", {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${openaiApiKey}`,
		},
		body: JSON.stringify({
			model: "gpt-4o-mini",
			messages: [
				{
					role: "system",
					content: `You are a task enrichment assistant. Take the task's title (content) and description, and:
1. Refine the title to be clear, concise, actionable, and professional.
2. Refine the description to be clear, well-structured, and easy to understand.
3. If the task is complex or multi-step, break it down into relevant sub-tasks. If no sub-tasks are needed, return an empty list.

You must respond strictly with a valid JSON object matching the following structure:
{
  "content": "actionable title",
  "description": "clear description",
  "subtasks": ["subtask 1", "subtask 2"]
}
Do not include any markdown formatting, code blocks, or preamble.`
				},
				{
					role: "user",
					content: `Task Title: ${task.content}\nTask Description: ${task.description}`
				}
			],
			response_format: { type: "json_object" },
			temperature: 0.7,
		}),
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw new Error(`OpenAI API error: ${response.status} - ${errorText}`);
	}

	const result = await response.json() as {
		choices: Array<{
			message: {
				content: string;
			};
		}>;
	};

	const replyText = result.choices[0]?.message?.content;
	if (!replyText) {
		throw new Error("Empty response from OpenAI");
	}

	const enriched = JSON.parse(replyText) as {
		content: string;
		description: string;
		subtasks?: string[];
	};

	console.log(`Received enriched data for task ${task.id}:`, enriched);

	console.log(`Updating task ${task.id} in Todoist...`);
	const updateResponse = await fetch(`https://api.todoist.com/rest/v2/tasks/${task.id}`, {
		method: "POST",
		headers: {
			"Content-Type": "application/json",
			"Authorization": `Bearer ${todoistApiToken}`,
		},
		body: JSON.stringify({
			content: enriched.content,
			description: enriched.description,
		}),
	});

	if (!updateResponse.ok) {
		const errorText = await updateResponse.text();
		throw new Error(`Todoist API error updating task: ${updateResponse.status} - ${errorText}`);
	}

	console.log(`Successfully updated task ${task.id} in Todoist`);

	if (enriched.subtasks && enriched.subtasks.length > 0) {
		console.log(`Creating ${enriched.subtasks.length} sub-tasks for task ${task.id} in Todoist...`);
		for (const subtaskContent of enriched.subtasks) {
			const subtaskResponse = await fetch("https://api.todoist.com/rest/v2/tasks", {
				method: "POST",
				headers: {
					"Content-Type": "application/json",
					"Authorization": `Bearer ${todoistApiToken}`,
				},
				body: JSON.stringify({
					content: subtaskContent,
					parent_id: task.id,
				}),
			});

			if (!subtaskResponse.ok) {
				const errorText = await subtaskResponse.text();
				console.error(`Failed to create subtask "${subtaskContent}": ${subtaskResponse.status} - ${errorText}`);
			} else {
				const subtaskData = await subtaskResponse.json() as { id: string };
				console.log(`Created subtask: "${subtaskContent}" with ID: ${subtaskData.id}`);
			}
		}
	}

	return enriched;
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
