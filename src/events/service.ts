import type { AdjustmentList } from "../billing/balance-adjustments";
import { InvalidRequestError } from "../billing/errors";
import type { ProjectInstanceContext } from "../projects/context";
import {
	normalizeWebhookDescription,
	normalizeWebhookEventTypes,
	normalizeWebhookUrl,
	type WebhookDeliveryListOptions,
	type WebhookDeliveryRecord,
	type WebhookEndpointCreateInput,
	type WebhookEndpointCreateResult,
	type WebhookEndpointRecord,
	type WebhookEndpointServiceLike,
	type WebhookEndpointUpdateInput,
	type WebhookReplayInput,
	type WebhookSecretRotationInput,
	type WebhookSecretRotationResult,
	type WebhookTestEventResult,
	webhookEndpointRequestHash,
	webhookSecretOverlapHoursMax,
} from "./endpoints";
import type { SealedWebhookSecret, WebhookSecretSealer } from "./secret-sealer";
import { generateWebhookSecret } from "./signing";

/** The persistence the service needs; `WebhookEndpointRepository` implements it. */
export interface WebhookEndpointStore {
	insertEndpoint(
		projectId: string,
		input: {
			id: string;
			url: string;
			description: string | null;
			eventTypes: string[];
			enabled: boolean;
			secretEnvelope: SealedWebhookSecret;
			createdBy: string;
			idempotencyKey: string;
			requestHash: string;
		},
	): Promise<{ duplicate: boolean; endpoint: WebhookEndpointRecord }>;
	listEndpoints(projectId: string): Promise<WebhookEndpointRecord[]>;
	getEndpoint(projectId: string, endpointId: string): Promise<WebhookEndpointRecord>;
	updateEndpoint(
		projectId: string,
		endpointId: string,
		input: WebhookEndpointUpdateInput,
	): Promise<WebhookEndpointRecord>;
	deleteEndpoint(projectId: string, endpointId: string): Promise<{ id: string }>;
	rotateSecret(
		projectId: string,
		endpointId: string,
		rotation: {
			seal(generation: number): SealedWebhookSecret;
			overlapHours: number;
			idempotencyKey: string;
		},
	): Promise<{ duplicate: boolean; endpoint: WebhookEndpointRecord }>;
	insertTestEvent(projectId: string, endpointId: string): Promise<WebhookTestEventResult>;
	replay(
		projectId: string,
		endpointId: string,
		query: { from: Date; to: Date; eventTypes: string[] },
	): Promise<number>;
	listDeliveries(
		projectId: string,
		options: WebhookDeliveryListOptions,
	): Promise<AdjustmentList<WebhookDeliveryRecord>>;
	retryDelivery(
		projectId: string,
		deliveryId: string,
	): Promise<{ deliveryId: string; status: "pending" }>;
}

export interface WebhookEndpointServiceOptions {
	store: WebhookEndpointStore;
	/** Resolved on first use, so building the service needs no secrets key. */
	sealer: () => WebhookSecretSealer;
	/** Whether endpoints may use plain http, which only approved private networks can receive. */
	allowInsecureHttp: boolean;
	newId?: () => string;
	generateSecret?: () => string;
}

export class WebhookEndpointService implements WebhookEndpointServiceLike {
	private readonly store: WebhookEndpointStore;
	private readonly sealer: () => WebhookSecretSealer;
	private readonly allowInsecureHttp: boolean;
	private readonly newId: () => string;
	private readonly generateSecret: () => string;

	constructor({
		store,
		sealer,
		allowInsecureHttp,
		newId = () => Bun.randomUUIDv7(),
		generateSecret = generateWebhookSecret,
	}: WebhookEndpointServiceOptions) {
		this.store = store;
		this.sealer = sealer;
		this.allowInsecureHttp = allowInsecureHttp;
		this.newId = newId;
		this.generateSecret = generateSecret;
	}

	async createEndpoint(
		project: ProjectInstanceContext,
		input: WebhookEndpointCreateInput,
	): Promise<WebhookEndpointCreateResult> {
		const terms = {
			url: normalizeWebhookUrl(input.url, { allowInsecureHttp: this.allowInsecureHttp }),
			description: normalizeWebhookDescription(input.description),
			eventTypes: normalizeWebhookEventTypes(input.eventTypes),
			enabled: input.enabled,
		};
		const projectId = project.projectInstanceId;
		const id = this.newId();
		const secret = this.generateSecret();
		const result = await this.store.insertEndpoint(projectId, {
			id,
			...terms,
			secretEnvelope: this.sealer().seal(secret, { projectId, endpointId: id, generation: 1 }),
			createdBy: input.actor,
			idempotencyKey: input.idempotencyKey,
			requestHash: webhookEndpointRequestHash(terms),
		});
		return result.duplicate
			? { duplicate: true, endpoint: result.endpoint, secret: null, secretDisclosed: false }
			: { duplicate: false, endpoint: result.endpoint, secret, secretDisclosed: true };
	}

	async listEndpoints(project: ProjectInstanceContext): Promise<WebhookEndpointRecord[]> {
		return await this.store.listEndpoints(project.projectInstanceId);
	}

	async getEndpoint(
		project: ProjectInstanceContext,
		endpointId: string,
	): Promise<WebhookEndpointRecord> {
		return await this.store.getEndpoint(project.projectInstanceId, endpointId);
	}

	async updateEndpoint(
		project: ProjectInstanceContext,
		endpointId: string,
		input: WebhookEndpointUpdateInput,
	): Promise<WebhookEndpointRecord> {
		const update: WebhookEndpointUpdateInput = {
			...(input.url === undefined
				? {}
				: { url: normalizeWebhookUrl(input.url, { allowInsecureHttp: this.allowInsecureHttp }) }),
			...(input.description === undefined
				? {}
				: { description: normalizeWebhookDescription(input.description) }),
			...(input.eventTypes === undefined
				? {}
				: { eventTypes: normalizeWebhookEventTypes(input.eventTypes) }),
			...(input.enabled === undefined ? {} : { enabled: input.enabled }),
		};
		if (Object.keys(update).length === 0) {
			throw new InvalidRequestError(
				"An update must change url, description, eventTypes or enabled",
			);
		}
		return await this.store.updateEndpoint(project.projectInstanceId, endpointId, update);
	}

	async deleteEndpoint(
		project: ProjectInstanceContext,
		endpointId: string,
	): Promise<{ id: string }> {
		return await this.store.deleteEndpoint(project.projectInstanceId, endpointId);
	}

	async rotateSecret(
		project: ProjectInstanceContext,
		endpointId: string,
		input: WebhookSecretRotationInput,
	): Promise<WebhookSecretRotationResult> {
		if (
			!Number.isInteger(input.overlapHours) ||
			input.overlapHours < 0 ||
			input.overlapHours > webhookSecretOverlapHoursMax
		) {
			throw new InvalidRequestError(
				`overlapHours must be a whole number from 0 to ${webhookSecretOverlapHoursMax}`,
			);
		}
		const projectId = project.projectInstanceId;
		const secret = this.generateSecret();
		const result = await this.store.rotateSecret(projectId, endpointId, {
			seal: (generation) => this.sealer().seal(secret, { projectId, endpointId, generation }),
			overlapHours: input.overlapHours,
			idempotencyKey: input.idempotencyKey,
		});
		return result.duplicate
			? { duplicate: true, endpoint: result.endpoint, secret: null, secretDisclosed: false }
			: { duplicate: false, endpoint: result.endpoint, secret, secretDisclosed: true };
	}

	async sendTestEvent(
		project: ProjectInstanceContext,
		endpointId: string,
	): Promise<WebhookTestEventResult> {
		return await this.store.insertTestEvent(project.projectInstanceId, endpointId);
	}

	async replay(
		project: ProjectInstanceContext,
		endpointId: string,
		input: WebhookReplayInput,
	): Promise<{ queued: number }> {
		if (!(input.from.getTime() < input.to.getTime())) {
			throw new InvalidRequestError("from must be earlier than to");
		}
		const queued = await this.store.replay(project.projectInstanceId, endpointId, {
			from: input.from,
			to: input.to,
			eventTypes: normalizeWebhookEventTypes(input.eventTypes),
		});
		return { queued };
	}

	async listDeliveries(
		project: ProjectInstanceContext,
		options: WebhookDeliveryListOptions,
	): Promise<AdjustmentList<WebhookDeliveryRecord>> {
		return await this.store.listDeliveries(project.projectInstanceId, options);
	}

	async retryDelivery(
		project: ProjectInstanceContext,
		deliveryId: string,
	): Promise<{ deliveryId: string; status: "pending" }> {
		return await this.store.retryDelivery(project.projectInstanceId, deliveryId);
	}
}
