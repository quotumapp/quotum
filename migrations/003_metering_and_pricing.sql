-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Metering and pricing: versioned catalog, plans and prices, usage, balances, controls, contracts,
-- licenses, and commercial previews.

CREATE TABLE IF NOT EXISTS metering_settings (
	project_id UUID PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
	client_idempotency_ttl_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (
		client_idempotency_ttl_seconds BETWEEN 60 AND 604800
	),
	worker_delivery_ttl_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (
		worker_delivery_ttl_seconds BETWEEN 60 AND 604800
	),
	occurred_at_max_skew_seconds INTEGER NOT NULL DEFAULT 300 CHECK (
		occurred_at_max_skew_seconds BETWEEN 0 AND 86400
	),
	raw_usage_retention_days INTEGER NOT NULL DEFAULT 400 CHECK (
		raw_usage_retention_days BETWEEN 30 AND 3650
	),
	consume_p99_target_ms INTEGER NOT NULL DEFAULT 50 CHECK (
		consume_p99_target_ms BETWEEN 1 AND 10000
	),
	projection_usage_debounce_ms INTEGER NOT NULL DEFAULT 1000 CHECK (
		projection_usage_debounce_ms BETWEEN 0 AND 30000
	),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

INSERT INTO metering_settings (project_id)
SELECT id FROM projects
ON CONFLICT (project_id) DO NOTHING;

CREATE TABLE IF NOT EXISTS catalog_revisions (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	revision INTEGER NOT NULL CHECK (revision > 0),
	status TEXT NOT NULL CHECK (status IN ('draft', 'validating', 'syncing', 'ready', 'published', 'failed')),
	intent_hash TEXT NOT NULL CHECK (char_length(intent_hash) = 64),
	created_by TEXT NOT NULL,
	published_at TIMESTAMPTZ,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT catalog_revisions_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT catalog_revisions_project_revision_unique UNIQUE (project_id, revision),
	CONSTRAINT catalog_revisions_publish_state_check CHECK (
		(status = 'published' AND published_at IS NOT NULL)
		OR (status <> 'published' AND published_at IS NULL)
	)
);

CREATE TABLE IF NOT EXISTS catalog_drafts (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	base_revision INTEGER,
	next_revision INTEGER NOT NULL CHECK (next_revision > 0),
	intent_hash TEXT NOT NULL CHECK (char_length(intent_hash) = 64),
	preview_token TEXT NOT NULL CHECK (char_length(preview_token) = 64),
	intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
	created_by TEXT NOT NULL,
	status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'published', 'expired')),
	expires_at TIMESTAMPTZ NOT NULL,
	published_revision_id BIGINT REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT catalog_drafts_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT catalog_drafts_project_token_unique UNIQUE (project_id, preview_token),
	CONSTRAINT catalog_drafts_state_check CHECK (
		(status = 'published' AND published_revision_id IS NOT NULL)
		OR (status <> 'published' AND published_revision_id IS NULL)
	)
);

CREATE TABLE IF NOT EXISTS catalog_audit_log (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	catalog_revision_id BIGINT NOT NULL REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	action TEXT NOT NULL,
	actor TEXT NOT NULL,
	intent_hash TEXT NOT NULL CHECK (char_length(intent_hash) = 64),
	details JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT catalog_audit_log_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT catalog_audit_log_project_revision_fk FOREIGN KEY (project_id, catalog_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT catalog_audit_log_action_check CHECK (
		action IN (
			'catalog_published', 'plan_migrated', 'catalog_archived',
			'contract_published', 'contract_terminated', 'control_changed',
			'auto_topup_reset', 'license_changed'
		)
	)
);

CREATE TABLE IF NOT EXISTS catalog_provider_operations (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	catalog_revision_id BIGINT NOT NULL REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	action TEXT NOT NULL,
	operation_key TEXT COLLATE "C" NOT NULL,
	store_product_id UUID NOT NULL REFERENCES store_products(id) ON DELETE RESTRICT,
	status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'ready', 'failed')),
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_error TEXT,
	completed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT catalog_provider_operations_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT catalog_provider_operations_key_unique UNIQUE (project_id, operation_key),
	CONSTRAINT catalog_provider_operations_project_revision_fk
		FOREIGN KEY (project_id, catalog_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT catalog_provider_operations_project_store_fk
		FOREIGN KEY (project_id, store_product_id)
		REFERENCES store_products(project_id, id),
	CONSTRAINT catalog_provider_operations_state_check CHECK (
		(status = 'ready' AND completed_at IS NOT NULL AND last_error IS NULL)
		OR (status = 'failed' AND last_error IS NOT NULL AND completed_at IS NULL)
		OR (status IN ('pending', 'processing') AND completed_at IS NULL)
	),
	CONSTRAINT catalog_provider_operations_action_check CHECK (
		action IN ('adopt_plan', 'adopt_topup', 'adopt_price')
	)
);

CREATE TABLE IF NOT EXISTS features (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	key TEXT COLLATE "C" NOT NULL,
	name TEXT NOT NULL,
	kind TEXT NOT NULL CHECK (kind IN ('boolean', 'metered')),
	meter_kind TEXT CHECK (meter_kind IS NULL OR meter_kind IN ('consumable', 'non_consumable')),
	unit TEXT COLLATE "C" NOT NULL,
	credit_scale SMALLINT NOT NULL DEFAULT 0 CHECK (credit_scale BETWEEN 0 AND 9),
	filter_dimensions TEXT[] NOT NULL DEFAULT '{}',
	active BOOLEAN NOT NULL DEFAULT true,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT features_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT features_project_key_unique UNIQUE (project_id, key),
	CONSTRAINT features_kind_meter_check CHECK (
		(kind = 'boolean' AND meter_kind IS NULL AND credit_scale = 0)
		OR (kind = 'metered' AND meter_kind IS NOT NULL)
	),
	CONSTRAINT features_filter_dimensions_check CHECK (
		cardinality(filter_dimensions) <= 8
		AND array_position(filter_dimensions, '') IS NULL
	)
);

CREATE TABLE IF NOT EXISTS plans (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	key TEXT COLLATE "C" NOT NULL,
	name TEXT NOT NULL,
	active_version_id BIGINT,
	active BOOLEAN NOT NULL DEFAULT true,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT plans_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT plans_project_key_unique UNIQUE (project_id, key)
);

CREATE TABLE IF NOT EXISTS plan_versions (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	plan_id BIGINT NOT NULL REFERENCES plans(id) ON DELETE RESTRICT,
	catalog_revision_id BIGINT NOT NULL REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	version INTEGER NOT NULL CHECK (version > 0),
	status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'archived')),
	currency TEXT COLLATE "C",
	base_amount_minor BIGINT CHECK (base_amount_minor IS NULL OR base_amount_minor >= 0),
	billing_interval TEXT CHECK (billing_interval IS NULL OR billing_interval IN ('month', 'year')),
	trial_days INTEGER CHECK (trial_days IS NULL OR trial_days BETWEEN 0 AND 730),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	plan_kind TEXT NOT NULL DEFAULT 'base',
	tier_rank INTEGER NOT NULL DEFAULT 0,
	trial_requires_payment_method BOOLEAN NOT NULL DEFAULT true,
	trial_end_behavior TEXT NOT NULL DEFAULT 'cancel',
	upgrade_proration_behavior TEXT NOT NULL DEFAULT 'always_invoice',
	downgrade_proration_behavior TEXT NOT NULL DEFAULT 'none',
	visibility TEXT NOT NULL DEFAULT 'public',
	customer_id UUID,
	CONSTRAINT plan_versions_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT plan_versions_project_plan_version_unique UNIQUE (project_id, plan_id, version),
	CONSTRAINT plan_versions_project_plan_fk FOREIGN KEY (project_id, plan_id)
		REFERENCES plans(project_id, id),
	CONSTRAINT plan_versions_project_revision_fk FOREIGN KEY (project_id, catalog_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT plan_versions_price_check CHECK (
		(base_amount_minor IS NULL AND currency IS NULL)
		OR (base_amount_minor IS NOT NULL AND currency IS NOT NULL)
	),
	CONSTRAINT plan_versions_plan_kind_check CHECK (plan_kind IN ('base', 'addon')),
	CONSTRAINT plan_versions_trial_end_behavior_check CHECK (
		trial_end_behavior IN ('cancel', 'pause')
	),
	CONSTRAINT plan_versions_upgrade_proration_check CHECK (
		upgrade_proration_behavior IN ('always_invoice', 'create_prorations', 'none')
	),
	CONSTRAINT plan_versions_downgrade_proration_check CHECK (
		downgrade_proration_behavior IN ('always_invoice', 'create_prorations', 'none')
	),
	CONSTRAINT plan_versions_visibility_check CHECK (
		visibility IN ('public', 'customer_specific')
	),
	CONSTRAINT plan_versions_visibility_customer_check CHECK (
		(visibility = 'public' AND customer_id IS NULL)
		OR (visibility = 'customer_specific' AND customer_id IS NOT NULL)
	),
	CONSTRAINT plan_versions_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS plan_items (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	item_kind TEXT NOT NULL,
	quantity NUMERIC(28, 9),
	reset_interval TEXT CHECK (reset_interval IS NULL OR reset_interval IN ('month', 'year')),
	expires_after_seconds BIGINT CHECK (expires_after_seconds IS NULL OR expires_after_seconds > 0),
	overage_policy TEXT NOT NULL DEFAULT 'blocked' CHECK (overage_policy IN ('blocked', 'allowed')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	allocation_scope TEXT NOT NULL DEFAULT 'account',
	rollover_enabled BOOLEAN NOT NULL DEFAULT false,
	rollover_max_quantity NUMERIC(28, 9),
	rollover_expiry_mode TEXT NOT NULL DEFAULT 'none',
	rollover_expiry_months INTEGER,
	CONSTRAINT plan_items_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT plan_items_project_version_feature_unique UNIQUE (project_id, plan_version_id, feature_id),
	CONSTRAINT plan_items_project_version_fk FOREIGN KEY (project_id, plan_version_id)
		REFERENCES plan_versions(project_id, id),
	CONSTRAINT plan_items_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT plan_items_item_kind_check CHECK (
		item_kind IN ('access', 'allocation', 'meter_limit', 'licensed_quantity')
	),
	CONSTRAINT plan_items_quantity_check CHECK (
		(item_kind = 'access' AND quantity IS NULL AND reset_interval IS NULL)
		OR (
			item_kind IN ('allocation', 'meter_limit', 'licensed_quantity')
			AND quantity IS NOT NULL
			AND quantity > 0
		)
	),
	CONSTRAINT plan_items_licensed_reset_check CHECK (
		item_kind <> 'licensed_quantity' OR reset_interval IS NULL
	),
	CONSTRAINT plan_items_overage_check CHECK (
		overage_policy = 'blocked' OR item_kind = 'meter_limit'
	),
	CONSTRAINT plan_items_allocation_scope_check CHECK (
		allocation_scope IN ('account', 'entity', 'license_pool')
	),
	CONSTRAINT plan_items_rollover_max_check CHECK (
		rollover_max_quantity IS NULL OR rollover_max_quantity > 0
	),
	CONSTRAINT plan_items_rollover_expiry_check CHECK (
		(
			rollover_enabled = false
			AND rollover_max_quantity IS NULL
			AND rollover_expiry_mode = 'none'
			AND rollover_expiry_months IS NULL
		)
		OR (
			rollover_enabled = true
			AND rollover_expiry_mode IN ('forever', 'months')
			AND (
				(rollover_expiry_mode = 'forever' AND rollover_expiry_months IS NULL)
				OR (rollover_expiry_mode = 'months' AND rollover_expiry_months BETWEEN 1 AND 120)
			)
		)
	),
	CONSTRAINT plan_items_rollover_kind_check CHECK (
		rollover_enabled = false OR item_kind = 'allocation'
	)
);

CREATE TABLE IF NOT EXISTS rate_card_entries (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	catalog_revision_id BIGINT NOT NULL REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	meter_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	wallet_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	rate_per_unit NUMERIC(38, 18) NOT NULL CHECK (rate_per_unit > 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	pricing_model TEXT NOT NULL DEFAULT 'flat',
	CONSTRAINT rate_card_entries_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT rate_card_entries_project_meter_unique UNIQUE (
		project_id,
		catalog_revision_id,
		meter_feature_id
	),
	CONSTRAINT rate_card_entries_project_revision_fk FOREIGN KEY (project_id, catalog_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT rate_card_entries_project_meter_fk FOREIGN KEY (project_id, meter_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT rate_card_entries_project_wallet_fk FOREIGN KEY (project_id, wallet_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT rate_card_entries_distinct_features_check CHECK (meter_feature_id <> wallet_feature_id),
	CONSTRAINT rate_card_entries_pricing_model_check CHECK (
		pricing_model IN ('flat', 'graduated')
	)
);

CREATE TABLE IF NOT EXISTS provider_plan_bindings (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	store_product_id UUID NOT NULL REFERENCES store_products(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	status TEXT NOT NULL CHECK (status IN ('validating', 'syncing', 'ready', 'published', 'failed')),
	error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT provider_plan_bindings_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT provider_plan_bindings_project_store_unique UNIQUE (project_id, store_product_id),
	CONSTRAINT provider_plan_bindings_project_version_fk FOREIGN KEY (project_id, plan_version_id)
		REFERENCES plan_versions(project_id, id),
	CONSTRAINT provider_plan_bindings_project_store_fk FOREIGN KEY (project_id, store_product_id)
		REFERENCES store_products(project_id, id)
);

CREATE TABLE IF NOT EXISTS topup_options (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	catalog_revision_id BIGINT NOT NULL REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	key TEXT COLLATE "C" NOT NULL,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	quantity NUMERIC(28, 9) NOT NULL CHECK (quantity > 0),
	expires_after_seconds BIGINT CHECK (expires_after_seconds IS NULL OR expires_after_seconds > 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT topup_options_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT topup_options_project_revision_key_unique UNIQUE (project_id, catalog_revision_id, key),
	CONSTRAINT topup_options_project_revision_fk FOREIGN KEY (project_id, catalog_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT topup_options_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id)
);

CREATE TABLE IF NOT EXISTS provider_topup_bindings (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	topup_option_id BIGINT NOT NULL REFERENCES topup_options(id) ON DELETE RESTRICT,
	store_product_id UUID NOT NULL REFERENCES store_products(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	status TEXT NOT NULL CHECK (status IN ('validating', 'syncing', 'ready', 'published', 'failed')),
	error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT provider_topup_bindings_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT provider_topup_bindings_project_store_unique UNIQUE (project_id, store_product_id),
	CONSTRAINT provider_topup_bindings_project_option_fk FOREIGN KEY (project_id, topup_option_id)
		REFERENCES topup_options(project_id, id),
	CONSTRAINT provider_topup_bindings_project_store_fk FOREIGN KEY (project_id, store_product_id)
		REFERENCES store_products(project_id, id)
);

CREATE TABLE IF NOT EXISTS entities (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	external_id TEXT COLLATE "C" NOT NULL,
	kind TEXT COLLATE "C" NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entities_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT entities_project_customer_external_unique UNIQUE (project_id, customer_id, external_id),
	CONSTRAINT entities_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS balance_allocations (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	plan_item_id BIGINT REFERENCES plan_items(id) ON DELETE SET NULL,
	subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
	purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
	credit_grant_id UUID REFERENCES credit_grants(id) ON DELETE SET NULL,
	source_kind TEXT NOT NULL CHECK (
		source_kind IN ('subscription', 'purchase', 'credit_grant', 'topup', 'reward', 'operator', 'rollover')
	),
	source_key TEXT COLLATE "C" NOT NULL,
	quantity NUMERIC(28, 9) NOT NULL CHECK (quantity > 0),
	reversed_quantity NUMERIC(28, 9) NOT NULL DEFAULT 0 CHECK (
		reversed_quantity >= 0 AND reversed_quantity <= quantity
	),
	consumed_quantity NUMERIC(28, 9) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
	held_quantity NUMERIC(28, 9) NOT NULL DEFAULT 0 CHECK (held_quantity >= 0),
	period_start_at TIMESTAMPTZ,
	period_end_at TIMESTAMPTZ,
	expires_at TIMESTAMPTZ,
	reversed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	rollover_origin_allocation_id BIGINT,
	rollover_policy_revision INTEGER,
	rollover_processed_at TIMESTAMPTZ,
	promotion_redemption_id UUID,
	plan_grant_id UUID,
	CONSTRAINT balance_allocations_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT balance_allocations_source_unique UNIQUE (project_id, feature_id, source_kind, source_key),
	CONSTRAINT balance_allocations_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT balance_allocations_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT balance_allocations_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT balance_allocations_project_plan_item_fk FOREIGN KEY (project_id, plan_item_id)
		REFERENCES plan_items(project_id, id)
		ON DELETE SET NULL,
	CONSTRAINT balance_allocations_capacity_check CHECK (
		consumed_quantity + held_quantity <= quantity
	),
	CONSTRAINT balance_allocations_period_check CHECK (
		period_start_at IS NULL OR period_end_at IS NULL OR period_start_at < period_end_at
	),
	CONSTRAINT balance_allocations_rollover_origin_fk
		FOREIGN KEY (project_id, rollover_origin_allocation_id)
		REFERENCES balance_allocations(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT balance_allocations_rollover_shape_check CHECK (
		(source_kind = 'rollover' AND rollover_origin_allocation_id IS NOT NULL
			AND rollover_policy_revision IS NOT NULL AND rollover_policy_revision > 0)
		OR (source_kind <> 'rollover' AND rollover_origin_allocation_id IS NULL
			AND rollover_policy_revision IS NULL)
	),
	-- A reward exists only as the effect of a promotion redemption or a plan grant, which carries
	-- its provenance.
	CONSTRAINT balance_allocations_reward_provenance_check CHECK (
		(source_kind = 'reward') = (promotion_redemption_id IS NOT NULL OR plan_grant_id IS NOT NULL)
	)
);

CREATE TABLE IF NOT EXISTS client_idempotency_claims (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	operation TEXT COLLATE "C" NOT NULL,
	idempotency_key TEXT COLLATE "C" NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
	request_fingerprint TEXT NOT NULL CHECK (char_length(request_fingerprint) = 64),
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	recovery_version SMALLINT NOT NULL DEFAULT 0 CHECK (recovery_version IN (0, 1)),
	retention_policy_version TEXT NOT NULL DEFAULT 'usage-recovery-v1'
  CHECK (retention_policy_version = 'usage-recovery-v1'),
	completed_at TIMESTAMPTZ,
	result_expires_at TIMESTAMPTZ,
	outcome JSONB,
	CONSTRAINT client_idempotency_claims_scope_unique UNIQUE (
		project_id,
		customer_id,
		operation,
		idempotency_key
	),
	CONSTRAINT client_idempotency_claims_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT client_idempotency_claims_expiry_check CHECK (expires_at > created_at),
	CONSTRAINT client_operation_completion_check CHECK (
  (completed_at IS NULL AND result_expires_at IS NULL AND outcome IS NULL)
  OR (completed_at IS NOT NULL AND result_expires_at IS NOT NULL
   AND result_expires_at >= completed_at + INTERVAL '24 hours'
   AND expires_at >= result_expires_at
   AND (recovery_version = 0 OR expires_at >= completed_at + INTERVAL '168 hours'))
 ),
	CONSTRAINT client_operation_outcome_bound CHECK (
  outcome IS NULL OR (jsonb_typeof(outcome) = 'object' AND octet_length(outcome::text) <= 65536)
 )
);

CREATE TABLE IF NOT EXISTS worker_delivery_claims (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	delivery_id TEXT COLLATE "C" NOT NULL CHECK (char_length(delivery_id) BETWEEN 1 AND 256),
	request_context_id TEXT COLLATE "C" NOT NULL,
	expires_at TIMESTAMPTZ NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT worker_delivery_claims_scope_unique UNIQUE (project_id, delivery_id),
	CONSTRAINT worker_delivery_claims_expiry_check CHECK (expires_at > created_at)
);

CREATE TABLE IF NOT EXISTS usage_windows (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	filter_key TEXT COLLATE "C",
	anchor_plan_item_id BIGINT REFERENCES plan_items(id) ON DELETE SET NULL,
	window_start_at TIMESTAMPTZ NOT NULL,
	window_end_at TIMESTAMPTZ NOT NULL,
	usage NUMERIC(28, 9) NOT NULL DEFAULT 0 CHECK (usage >= 0),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	subscription_id UUID REFERENCES subscriptions(id) ON DELETE RESTRICT,
	CONSTRAINT usage_windows_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT usage_windows_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT usage_windows_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT usage_windows_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT usage_windows_project_anchor_fk FOREIGN KEY (project_id, anchor_plan_item_id)
		REFERENCES plan_items(project_id, id)
		ON DELETE SET NULL,
	CONSTRAINT usage_windows_bounds_check CHECK (window_start_at < window_end_at),
	CONSTRAINT usage_windows_filter_key_check CHECK (filter_key IS NULL OR filter_key <> ''),
	CONSTRAINT usage_windows_project_subscription_fk
		FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS reservations (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	usage_window_id BIGINT REFERENCES usage_windows(id) ON DELETE SET NULL,
	usage_window_start_at TIMESTAMPTZ,
	usage_window_end_at TIMESTAMPTZ,
	meter_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	wallet_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	rate_card_entry_id BIGINT REFERENCES rate_card_entries(id) ON DELETE RESTRICT,
	rate_card_revision_id BIGINT REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	rate_card_path TEXT NOT NULL CHECK (rate_card_path IN ('direct', 'pinned', 'additive')),
	requested_quantity NUMERIC(28, 9) NOT NULL CHECK (requested_quantity > 0),
	held_quantity NUMERIC(28, 9) NOT NULL CHECK (held_quantity >= 0),
	confirmed_quantity NUMERIC(28, 9),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'confirmed', 'released', 'expired')),
	effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ NOT NULL,
	finalized_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT reservations_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT reservations_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT reservations_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT reservations_project_usage_window_fk FOREIGN KEY (project_id, usage_window_id)
		REFERENCES usage_windows(project_id, id)
		ON DELETE SET NULL,
	CONSTRAINT reservations_project_meter_feature_fk FOREIGN KEY (project_id, meter_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT reservations_project_wallet_feature_fk FOREIGN KEY (project_id, wallet_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT reservations_project_rate_entry_fk FOREIGN KEY (project_id, rate_card_entry_id)
		REFERENCES rate_card_entries(project_id, id),
	CONSTRAINT reservations_project_rate_revision_fk FOREIGN KEY (project_id, rate_card_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT reservations_expiry_check CHECK (expires_at > effective_at),
	CONSTRAINT reservations_usage_window_check CHECK (
		(usage_window_id IS NULL AND usage_window_start_at IS NULL AND usage_window_end_at IS NULL)
		OR (
			usage_window_id IS NOT NULL
			AND usage_window_start_at IS NOT NULL
			AND usage_window_end_at IS NOT NULL
			AND usage_window_start_at < usage_window_end_at
		)
	),
	CONSTRAINT reservations_final_state_check CHECK (
		(status = 'active' AND finalized_at IS NULL AND confirmed_quantity IS NULL)
		OR (status = 'confirmed' AND finalized_at IS NOT NULL AND confirmed_quantity IS NOT NULL)
		OR (status IN ('released', 'expired') AND finalized_at IS NOT NULL AND confirmed_quantity IS NULL)
	)
);

CREATE TABLE IF NOT EXISTS reservation_allocations (
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
	allocation_id BIGINT NOT NULL REFERENCES balance_allocations(id) ON DELETE RESTRICT,
	held_quantity NUMERIC(28, 9) NOT NULL CHECK (held_quantity >= 0),
	consumed_quantity NUMERIC(28, 9) NOT NULL DEFAULT 0 CHECK (consumed_quantity >= 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, reservation_id, allocation_id),
	CONSTRAINT reservation_allocations_project_reservation_fk FOREIGN KEY (project_id, reservation_id)
		REFERENCES reservations(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT reservation_allocations_project_allocation_fk FOREIGN KEY (project_id, allocation_id)
		REFERENCES balance_allocations(project_id, id)
		ON DELETE RESTRICT,
	CONSTRAINT reservation_allocations_consumed_check CHECK (consumed_quantity <= held_quantity)
);

CREATE TABLE IF NOT EXISTS usage_events (
	recorded_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	id UUID NOT NULL DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
	meter_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	wallet_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	reservation_id UUID REFERENCES reservations(id) ON DELETE SET NULL,
	original_event_id UUID,
	original_event_recorded_at TIMESTAMPTZ,
	operation TEXT NOT NULL CHECK (operation IN ('consume', 'confirm', 'correction')),
	quantity NUMERIC(28, 9) NOT NULL,
	wallet_quantity NUMERIC(28, 9) NOT NULL,
	occurred_at TIMESTAMPTZ,
	effective_at TIMESTAMPTZ NOT NULL,
	rate_card_entry_id BIGINT REFERENCES rate_card_entries(id) ON DELETE RESTRICT,
	rate_card_revision_id BIGINT REFERENCES catalog_revisions(id) ON DELETE RESTRICT,
	rate_card_path TEXT NOT NULL CHECK (rate_card_path IN ('direct', 'pinned', 'additive')),
	rate_inputs JSONB NOT NULL DEFAULT '{}'::jsonb,
	filter_key TEXT COLLATE "C",
	deductions JSONB NOT NULL DEFAULT '[]'::jsonb,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	PRIMARY KEY (recorded_at, id),
	CONSTRAINT usage_events_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT usage_events_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id)
		ON DELETE SET NULL,
	CONSTRAINT usage_events_project_meter_feature_fk FOREIGN KEY (project_id, meter_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT usage_events_project_wallet_feature_fk FOREIGN KEY (project_id, wallet_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT usage_events_project_rate_entry_fk FOREIGN KEY (project_id, rate_card_entry_id)
		REFERENCES rate_card_entries(project_id, id),
	CONSTRAINT usage_events_project_rate_revision_fk FOREIGN KEY (project_id, rate_card_revision_id)
		REFERENCES catalog_revisions(project_id, id),
	CONSTRAINT usage_events_quantity_check CHECK (
		(operation IN ('consume', 'confirm') AND quantity > 0 AND wallet_quantity >= 0)
		OR (operation = 'correction' AND quantity < 0 AND wallet_quantity <= 0)
	),
	CONSTRAINT usage_events_original_check CHECK (
		(operation = 'correction' AND original_event_id IS NOT NULL AND original_event_recorded_at IS NOT NULL)
		OR (operation <> 'correction' AND original_event_id IS NULL AND original_event_recorded_at IS NULL)
	),
	CONSTRAINT usage_events_deductions_check CHECK (jsonb_typeof(deductions) = 'array')
) PARTITION BY RANGE (recorded_at);

DO $$
DECLARE
	month_offset INTEGER;
	partition_start TIMESTAMPTZ;
	partition_end TIMESTAMPTZ;
	partition_name TEXT;
BEGIN
	-- Keep one prior month plus two years of monthly partitions ready on a fresh deployment.
	FOR month_offset IN -1..24 LOOP
		partition_start := date_trunc('month', now()) + make_interval(months => month_offset);
		partition_end := partition_start + interval '1 month';
		partition_name := 'usage_events_' || to_char(partition_start, 'YYYY_MM');
		EXECUTE format(
			'CREATE TABLE IF NOT EXISTS %I PARTITION OF usage_events FOR VALUES FROM (%L) TO (%L)',
			partition_name,
			partition_start,
			partition_end
		);
	END LOOP;
END;
$$;

CREATE TABLE IF NOT EXISTS usage_events_default
	PARTITION OF usage_events DEFAULT;

CREATE TABLE IF NOT EXISTS usage_event_rollups (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
	meter_feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	period_start_at TIMESTAMPTZ NOT NULL,
	period_end_at TIMESTAMPTZ NOT NULL,
	quantity NUMERIC(38, 9) NOT NULL DEFAULT 0,
	wallet_quantity NUMERIC(38, 9) NOT NULL DEFAULT 0,
	event_count BIGINT NOT NULL DEFAULT 0 CHECK (event_count >= 0),
	status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open', 'closed')),
	closed_at TIMESTAMPTZ,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT usage_event_rollups_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT usage_event_rollups_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT usage_event_rollups_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id)
		ON DELETE SET NULL,
	CONSTRAINT usage_event_rollups_project_feature_fk FOREIGN KEY (project_id, meter_feature_id)
		REFERENCES features(project_id, id),
	CONSTRAINT usage_event_rollups_period_check CHECK (period_start_at < period_end_at),
	CONSTRAINT usage_event_rollups_state_check CHECK (
		(status = 'open' AND closed_at IS NULL)
		OR (status = 'closed' AND closed_at IS NOT NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_event_rollups_scope
	ON usage_event_rollups (
		project_id,
		customer_id,
		meter_feature_id,
		COALESCE(entity_id, 0::bigint),
		period_start_at
	);

CREATE INDEX IF NOT EXISTS idx_billing_catalog_revisions_project_status
	ON catalog_revisions (project_id, status, revision DESC);

CREATE INDEX IF NOT EXISTS idx_billing_catalog_drafts_expiry
	ON catalog_drafts (expires_at)
	WHERE status = 'previewed';

CREATE INDEX IF NOT EXISTS idx_billing_catalog_audit_project_created
	ON catalog_audit_log (project_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_catalog_provider_operations_due
	ON catalog_provider_operations (status, created_at)
	WHERE status IN ('pending', 'processing', 'failed');

CREATE INDEX IF NOT EXISTS idx_billing_catalog_provider_operations_revision
	ON catalog_provider_operations (catalog_revision_id);

CREATE INDEX IF NOT EXISTS idx_billing_plan_versions_plan
	ON plan_versions (plan_id, version DESC);

CREATE INDEX IF NOT EXISTS idx_billing_plan_versions_revision
	ON plan_versions (catalog_revision_id);

CREATE INDEX IF NOT EXISTS idx_billing_plan_items_feature
	ON plan_items (feature_id);

CREATE INDEX IF NOT EXISTS idx_billing_rate_card_entries_wallet
	ON rate_card_entries (project_id, wallet_feature_id, catalog_revision_id);

CREATE INDEX IF NOT EXISTS idx_billing_provider_plan_bindings_version
	ON provider_plan_bindings (plan_version_id);

CREATE INDEX IF NOT EXISTS idx_billing_topup_options_feature
	ON topup_options (feature_id, catalog_revision_id);

CREATE INDEX IF NOT EXISTS idx_billing_provider_topup_bindings_option
	ON provider_topup_bindings (topup_option_id);

CREATE INDEX IF NOT EXISTS idx_billing_entities_customer
	ON entities (customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_spend_order
	ON balance_allocations (
		project_id,
		customer_id,
		feature_id,
		entity_id,
		expires_at,
		created_at,
		id
	)
	WHERE reversed_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_customer
	ON balance_allocations (customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_entity
	ON balance_allocations (entity_id)
	WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_plan_item
	ON balance_allocations (plan_item_id)
	WHERE plan_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_subscription
	ON balance_allocations (subscription_id)
	WHERE subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_purchase
	ON balance_allocations (purchase_id)
	WHERE purchase_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_credit_grant
	ON balance_allocations (credit_grant_id)
	WHERE credit_grant_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_client_idempotency_expiry
	ON client_idempotency_claims (expires_at);

CREATE INDEX IF NOT EXISTS idx_billing_worker_delivery_expiry
	ON worker_delivery_claims (expires_at);

CREATE INDEX IF NOT EXISTS idx_billing_usage_windows_customer_feature
	ON usage_windows (project_id, customer_id, feature_id);

CREATE INDEX IF NOT EXISTS idx_billing_usage_windows_entity
	ON usage_windows (entity_id)
	WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_usage_windows_anchor
	ON usage_windows (anchor_plan_item_id)
	WHERE anchor_plan_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_reservations_active_expiry
	ON reservations (expires_at, created_at)
	WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_billing_reservations_customer_feature
	ON reservations (project_id, customer_id, wallet_feature_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_reservations_entity
	ON reservations (entity_id)
	WHERE entity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_reservations_usage_window
	ON reservations (usage_window_id, status, expires_at)
	WHERE usage_window_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_reservation_allocations_allocation
	ON reservation_allocations (project_id, allocation_id);

CREATE INDEX IF NOT EXISTS idx_billing_usage_events_customer_time
	ON usage_events (project_id, customer_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_usage_events_project_time
	ON usage_events (project_id, recorded_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_billing_usage_events_feature_time
	ON usage_events (project_id, meter_feature_id, recorded_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_usage_events_reservation
	ON usage_events (reservation_id, recorded_at DESC)
	WHERE reservation_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_usage_events_original
	ON usage_events (original_event_recorded_at, original_event_id)
	WHERE original_event_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_usage_event_rollups_close
	ON usage_event_rollups (period_end_at, id)
	WHERE status = 'open';

CREATE TABLE IF NOT EXISTS price_components (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	plan_item_id BIGINT REFERENCES plan_items(id) ON DELETE RESTRICT,
	key TEXT COLLATE "C" NOT NULL,
	component_kind TEXT NOT NULL CHECK (
		component_kind IN ('base', 'licensed', 'metered_overage')
	),
	charge_timing TEXT NOT NULL CHECK (charge_timing IN ('in_advance', 'in_arrears')),
	currency TEXT COLLATE "C" NOT NULL CHECK (char_length(currency) = 3),
	unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
	billing_units NUMERIC(28, 9) NOT NULL DEFAULT 1 CHECK (billing_units > 0),
	billing_interval TEXT NOT NULL CHECK (billing_interval IN ('month', 'year')),
	minimum_quantity INTEGER NOT NULL DEFAULT 1 CHECK (minimum_quantity > 0),
	maximum_quantity INTEGER CHECK (
		maximum_quantity IS NULL OR maximum_quantity >= minimum_quantity
	),
	tax_behavior TEXT NOT NULL DEFAULT 'unspecified' CHECK (
		tax_behavior IN ('inclusive', 'exclusive', 'unspecified')
	),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	pricing_model TEXT NOT NULL DEFAULT 'flat',
	CONSTRAINT price_components_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT price_components_project_version_key_unique UNIQUE (
		project_id, plan_version_id, key
	),
	CONSTRAINT price_components_project_version_fk FOREIGN KEY (project_id, plan_version_id)
		REFERENCES plan_versions(project_id, id),
	CONSTRAINT price_components_project_item_fk FOREIGN KEY (project_id, plan_item_id)
		REFERENCES plan_items(project_id, id),
	CONSTRAINT price_components_shape_check CHECK (
		(component_kind = 'base' AND plan_item_id IS NULL AND charge_timing = 'in_advance')
		OR (component_kind = 'licensed' AND plan_item_id IS NOT NULL AND charge_timing = 'in_advance')
		OR (
			component_kind = 'metered_overage'
			AND plan_item_id IS NOT NULL
			AND charge_timing = 'in_arrears'
		)
	),
	CONSTRAINT price_components_pricing_model_check CHECK (
		pricing_model IN ('flat', 'graduated', 'volume')
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_price_components_base
	ON price_components (project_id, plan_version_id)
	WHERE component_kind = 'base';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_price_components_plan_item
	ON price_components (project_id, plan_item_id)
	WHERE plan_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_price_components_version
	ON price_components (plan_version_id);

CREATE TABLE IF NOT EXISTS provider_price_bindings (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	price_component_id BIGINT NOT NULL REFERENCES price_components(id) ON DELETE RESTRICT,
	store_product_id UUID NOT NULL REFERENCES store_products(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	status TEXT NOT NULL CHECK (
		status IN ('validating', 'syncing', 'ready', 'published', 'failed')
	),
	error TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT provider_price_bindings_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT provider_price_bindings_component_provider_unique UNIQUE (
		project_id, price_component_id, provider, channel
	),
	CONSTRAINT provider_price_bindings_project_component_fk
		FOREIGN KEY (project_id, price_component_id)
		REFERENCES price_components(project_id, id),
	CONSTRAINT provider_price_bindings_project_store_fk
		FOREIGN KEY (project_id, store_product_id)
		REFERENCES store_products(project_id, id)
);

CREATE INDEX IF NOT EXISTS idx_billing_provider_price_bindings_store
	ON provider_price_bindings (store_product_id);

CREATE TABLE IF NOT EXISTS subscription_items (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
	price_component_id BIGINT NOT NULL REFERENCES price_components(id) ON DELETE RESTRICT,
	provider_subscription_item_id TEXT,
	quantity INTEGER NOT NULL CHECK (quantity > 0),
	unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
	currency TEXT COLLATE "C" NOT NULL CHECK (char_length(currency) = 3),
	active BOOLEAN NOT NULL DEFAULT true,
	starts_at TIMESTAMPTZ NOT NULL,
	ends_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT subscription_items_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT subscription_items_project_subscription_component_unique UNIQUE (
		project_id, subscription_id, price_component_id
	),
	CONSTRAINT subscription_items_project_subscription_fk
		FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id) ON DELETE CASCADE,
	CONSTRAINT subscription_items_project_component_fk
		FOREIGN KEY (project_id, price_component_id)
		REFERENCES price_components(project_id, id),
	CONSTRAINT subscription_items_bounds_check CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscription_items_provider_item
	ON subscription_items (project_id, provider_subscription_item_id)
	WHERE provider_subscription_item_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_subscription_items_subscription_active
	ON subscription_items (subscription_id, active);

CREATE TABLE IF NOT EXISTS subscription_changes (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	provider_account_id TEXT,
	from_plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	to_plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	requested_quantities JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
		jsonb_typeof(requested_quantities) = 'object'
	),
	change_kind TEXT NOT NULL CHECK (change_kind IN ('upgrade', 'downgrade', 'quantity')),
	effective_mode TEXT NOT NULL CHECK (effective_mode IN ('immediate', 'period_end')),
	effective_at TIMESTAMPTZ NOT NULL,
	proration_behavior TEXT NOT NULL CHECK (
		proration_behavior IN ('always_invoice', 'create_prorations', 'none')
	),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (
		status IN ('pending', 'processing', 'applied', 'failed', 'cancelled')
	),
	idempotency_key TEXT NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 200),
	request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
	provider_request_id TEXT,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_error TEXT,
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	applied_at TIMESTAMPTZ,
	synchronized_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT subscription_changes_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT subscription_changes_project_customer_fk
		FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT subscription_changes_project_subscription_fk
		FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id) ON DELETE CASCADE,
	CONSTRAINT subscription_changes_project_from_plan_fk
		FOREIGN KEY (project_id, from_plan_version_id)
		REFERENCES plan_versions(project_id, id),
	CONSTRAINT subscription_changes_project_to_plan_fk
		FOREIGN KEY (project_id, to_plan_version_id)
		REFERENCES plan_versions(project_id, id),
	CONSTRAINT subscription_changes_synchronization_check CHECK (
		synchronized_at IS NULL OR status = 'applied'
	),
	CONSTRAINT subscription_changes_state_check CHECK (
		(status = 'applied' AND applied_at IS NOT NULL AND last_error IS NULL)
		OR (status = 'failed' AND last_error IS NOT NULL AND applied_at IS NULL)
		OR (status IN ('pending', 'processing', 'cancelled') AND applied_at IS NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscription_changes_idempotency
	ON subscription_changes (project_id, customer_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscription_changes_pending_scope
	ON subscription_changes (project_id, subscription_id)
	WHERE status IN ('pending', 'processing');

CREATE INDEX IF NOT EXISTS idx_billing_subscription_changes_due
	ON subscription_changes (effective_at, created_at)
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_subscription_changes_stale
	ON subscription_changes (locked_at, created_at)
	WHERE status = 'processing';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_windows_scope_period
	ON usage_windows (
		project_id,
		customer_id,
		feature_id,
		COALESCE(entity_id, 0::bigint),
		COALESCE(filter_key, '' COLLATE "C"),
		window_start_at,
		window_end_at
	);

CREATE INDEX IF NOT EXISTS idx_billing_usage_windows_closed_unbilled
	ON usage_windows (window_end_at, project_id, subscription_id, anchor_plan_item_id)
	WHERE subscription_id IS NOT NULL AND anchor_plan_item_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS usage_invoice_periods (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	provider_account_id TEXT,
	plan_item_id BIGINT NOT NULL REFERENCES plan_items(id) ON DELETE RESTRICT,
	price_component_id BIGINT NOT NULL REFERENCES price_components(id) ON DELETE RESTRICT,
	period_start_at TIMESTAMPTZ NOT NULL,
	period_end_at TIMESTAMPTZ NOT NULL,
	usage_quantity NUMERIC(28, 9) NOT NULL CHECK (usage_quantity >= 0),
	included_quantity NUMERIC(28, 9) NOT NULL CHECK (included_quantity >= 0),
	billable_quantity NUMERIC(28, 9) NOT NULL CHECK (billable_quantity >= 0),
	billing_units NUMERIC(28, 9) NOT NULL CHECK (billing_units > 0),
	unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
	amount_minor BIGINT NOT NULL CHECK (amount_minor >= 0),
	currency TEXT COLLATE "C" NOT NULL CHECK (char_length(currency) = 3),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (
		status IN ('pending', 'processing', 'invoiced', 'credited', 'failed')
	),
	external_invoice_id TEXT,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_error TEXT,
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	invoiced_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT usage_invoice_periods_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT usage_invoice_periods_scope_unique UNIQUE (
		project_id, subscription_id, plan_item_id, period_start_at, period_end_at
	),
	CONSTRAINT usage_invoice_periods_project_customer_fk
		FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT usage_invoice_periods_project_subscription_fk
		FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id),
	CONSTRAINT usage_invoice_periods_project_plan_item_fk
		FOREIGN KEY (project_id, plan_item_id) REFERENCES plan_items(project_id, id),
	CONSTRAINT usage_invoice_periods_project_component_fk
		FOREIGN KEY (project_id, price_component_id)
		REFERENCES price_components(project_id, id),
	CONSTRAINT usage_invoice_periods_bounds_check CHECK (period_end_at > period_start_at),
	CONSTRAINT usage_invoice_periods_state_check CHECK (
		(status IN ('invoiced', 'credited') AND invoiced_at IS NOT NULL AND last_error IS NULL)
		OR (status = 'failed' AND last_error IS NOT NULL AND invoiced_at IS NULL)
		OR (status IN ('pending', 'processing') AND invoiced_at IS NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_invoice_periods_external
	ON usage_invoice_periods (project_id, external_invoice_id)
	WHERE external_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_usage_invoice_periods_due
	ON usage_invoice_periods (period_end_at, created_at)
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_usage_invoice_periods_stale
	ON usage_invoice_periods (locked_at, created_at)
	WHERE status = 'processing';

CREATE TABLE IF NOT EXISTS usage_invoice_adjustments (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	closed_period_id UUID NOT NULL REFERENCES usage_invoice_periods(id) ON DELETE RESTRICT,
	usage_event_id UUID NOT NULL,
	usage_event_recorded_at TIMESTAMPTZ NOT NULL,
	quantity NUMERIC(28, 9) NOT NULL CHECK (quantity <> 0),
	amount_minor BIGINT NOT NULL,
	currency TEXT COLLATE "C" NOT NULL CHECK (char_length(currency) = 3),
	status TEXT NOT NULL DEFAULT 'pending' CHECK (
		status IN ('pending', 'processing', 'invoiced', 'credited', 'failed')
	),
	external_invoice_id TEXT,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	last_error TEXT,
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	invoiced_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT usage_invoice_adjustments_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT usage_invoice_adjustments_event_unique UNIQUE (
		project_id, usage_event_recorded_at, usage_event_id
	),
	CONSTRAINT usage_invoice_adjustments_event_fk
		FOREIGN KEY (usage_event_recorded_at, usage_event_id)
		REFERENCES usage_events(recorded_at, id) ON DELETE RESTRICT,
	CONSTRAINT usage_invoice_adjustments_project_period_fk
		FOREIGN KEY (project_id, closed_period_id)
		REFERENCES usage_invoice_periods(project_id, id),
	CONSTRAINT usage_invoice_adjustments_state_check CHECK (
		(status IN ('invoiced', 'credited') AND invoiced_at IS NOT NULL AND last_error IS NULL)
		OR (status = 'failed' AND last_error IS NOT NULL AND invoiced_at IS NULL)
		OR (status IN ('pending', 'processing') AND invoiced_at IS NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_usage_invoice_adjustments_external
	ON usage_invoice_adjustments (project_id, external_invoice_id)
	WHERE external_invoice_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_usage_invoice_adjustments_due
	ON usage_invoice_adjustments (created_at, id)
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_usage_invoice_adjustments_stale
	ON usage_invoice_adjustments (locked_at, id)
	WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_billing_plan_versions_customer
	ON plan_versions (project_id, customer_id, status)
	WHERE customer_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS price_tiers (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	price_component_id BIGINT NOT NULL REFERENCES price_components(id) ON DELETE RESTRICT,
	ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
	up_to_quantity NUMERIC(28, 9) CHECK (up_to_quantity IS NULL OR up_to_quantity > 0),
	unit_amount_minor BIGINT NOT NULL CHECK (unit_amount_minor >= 0),
	flat_amount_minor BIGINT NOT NULL DEFAULT 0 CHECK (flat_amount_minor >= 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT price_tiers_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT price_tiers_component_ordinal_unique UNIQUE (project_id, price_component_id, ordinal),
	CONSTRAINT price_tiers_project_component_fk FOREIGN KEY (project_id, price_component_id)
		REFERENCES price_components(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_billing_price_tiers_component
	ON price_tiers (project_id, price_component_id, ordinal);

CREATE TABLE IF NOT EXISTS rate_card_tiers (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	rate_card_entry_id BIGINT NOT NULL REFERENCES rate_card_entries(id) ON DELETE RESTRICT,
	ordinal INTEGER NOT NULL CHECK (ordinal >= 0),
	up_to_quantity NUMERIC(28, 9) CHECK (up_to_quantity IS NULL OR up_to_quantity > 0),
	rate_per_unit NUMERIC(38, 18) NOT NULL CHECK (rate_per_unit > 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT rate_card_tiers_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT rate_card_tiers_entry_ordinal_unique UNIQUE (project_id, rate_card_entry_id, ordinal),
	CONSTRAINT rate_card_tiers_project_entry_fk FOREIGN KEY (project_id, rate_card_entry_id)
		REFERENCES rate_card_entries(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_billing_rate_card_tiers_entry
	ON rate_card_tiers (project_id, rate_card_entry_id, ordinal);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_balance_allocations_rollover_origin
	ON balance_allocations (project_id, rollover_origin_allocation_id)
	WHERE rollover_origin_allocation_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS enterprise_contracts (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE RESTRICT,
	contract_key TEXT COLLATE "C" NOT NULL CHECK (char_length(contract_key) BETWEEN 1 AND 120),
	version INTEGER NOT NULL CHECK (version > 0),
	status TEXT NOT NULL CHECK (status IN ('draft', 'published', 'expired', 'terminated')),
	plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	replaces_commercial_defaults BOOLEAN NOT NULL DEFAULT true,
	effective_at TIMESTAMPTZ NOT NULL,
	expires_at TIMESTAMPTZ,
	terms JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(terms) = 'object'),
	preview_token TEXT COLLATE "C" NOT NULL CHECK (char_length(preview_token) = 64),
	intent_hash TEXT COLLATE "C" NOT NULL CHECK (char_length(intent_hash) = 64),
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	published_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT enterprise_contracts_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT enterprise_contracts_key_version_unique UNIQUE (
		project_id, customer_id, contract_key, version
	),
	CONSTRAINT enterprise_contracts_preview_token_unique UNIQUE (project_id, preview_token),
	CONSTRAINT enterprise_contracts_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT enterprise_contracts_project_plan_fk FOREIGN KEY (project_id, plan_version_id)
		REFERENCES plan_versions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT enterprise_contracts_bounds_check CHECK (expires_at IS NULL OR expires_at > effective_at),
	CONSTRAINT enterprise_contracts_publish_check CHECK (
		(status = 'draft' AND published_at IS NULL)
		OR (status <> 'draft' AND published_at IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_enterprise_contracts_active
	ON enterprise_contracts (project_id, customer_id, effective_at DESC, version DESC)
	WHERE status = 'published';

CREATE INDEX IF NOT EXISTS idx_billing_enterprise_contracts_customer
	ON enterprise_contracts (project_id, customer_id, effective_at DESC);

CREATE TABLE IF NOT EXISTS control_policies (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	source_type TEXT NOT NULL CHECK (
		source_type IN ('plan_default', 'contract', 'account', 'entity')
	),
	plan_version_id BIGINT REFERENCES plan_versions(id) ON DELETE RESTRICT,
	contract_id BIGINT REFERENCES enterprise_contracts(id) ON DELETE RESTRICT,
	customer_id UUID REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	control_kind TEXT NOT NULL CHECK (control_kind IN ('spend_limit', 'usage_limit')),
	feature_id BIGINT REFERENCES features(id) ON DELETE RESTRICT,
	currency TEXT COLLATE "C",
	limit_value NUMERIC(38, 9) NOT NULL CHECK (limit_value >= 0),
	interval TEXT NOT NULL CHECK (interval IN ('month', 'year', 'lifetime')),
	revision INTEGER NOT NULL CHECK (revision > 0),
	effective_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ,
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT control_policies_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT control_policies_project_plan_fk FOREIGN KEY (project_id, plan_version_id)
		REFERENCES plan_versions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT control_policies_project_contract_fk FOREIGN KEY (project_id, contract_id)
		REFERENCES enterprise_contracts(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT control_policies_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT control_policies_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id) ON DELETE CASCADE,
	CONSTRAINT control_policies_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT control_policies_bounds_check CHECK (expires_at IS NULL OR expires_at > effective_at),
	CONSTRAINT control_policies_value_shape_check CHECK (
		(control_kind = 'spend_limit' AND currency IS NOT NULL AND feature_id IS NULL
			AND trunc(limit_value) = limit_value)
		OR (control_kind = 'usage_limit' AND currency IS NULL AND feature_id IS NOT NULL)
	),
	CONSTRAINT control_policies_source_shape_check CHECK (
		(source_type = 'plan_default' AND plan_version_id IS NOT NULL AND contract_id IS NULL
			AND customer_id IS NULL AND entity_id IS NULL)
		OR (source_type = 'contract' AND plan_version_id IS NULL AND contract_id IS NOT NULL
			AND customer_id IS NULL AND entity_id IS NULL)
		OR (source_type = 'account' AND plan_version_id IS NULL AND contract_id IS NULL
			AND customer_id IS NOT NULL AND entity_id IS NULL)
		OR (source_type = 'entity' AND plan_version_id IS NULL AND contract_id IS NULL
			AND customer_id IS NOT NULL AND entity_id IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_control_policies_plan
	ON control_policies (project_id, plan_version_id, control_kind)
	WHERE source_type = 'plan_default' AND active = true;

CREATE INDEX IF NOT EXISTS idx_billing_control_policies_contract
	ON control_policies (project_id, contract_id, control_kind)
	WHERE source_type = 'contract' AND active = true;

CREATE INDEX IF NOT EXISTS idx_billing_control_policies_account
	ON control_policies (project_id, customer_id, control_kind, feature_id)
	WHERE source_type IN ('account', 'entity') AND active = true;

CREATE TABLE IF NOT EXISTS control_windows (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	control_policy_id BIGINT NOT NULL REFERENCES control_policies(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	window_start_at TIMESTAMPTZ NOT NULL,
	window_end_at TIMESTAMPTZ,
	consumed_value NUMERIC(38, 9) NOT NULL DEFAULT 0 CHECK (consumed_value >= 0),
	held_value NUMERIC(38, 9) NOT NULL DEFAULT 0 CHECK (held_value >= 0),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT control_windows_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT control_windows_scope_unique UNIQUE (
		project_id, control_policy_id, customer_id, window_start_at
	),
	CONSTRAINT control_windows_project_policy_fk FOREIGN KEY (project_id, control_policy_id)
		REFERENCES control_policies(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT control_windows_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT control_windows_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id) ON DELETE CASCADE,
	CONSTRAINT control_windows_bounds_check CHECK (window_end_at IS NULL OR window_end_at > window_start_at)
);

CREATE INDEX IF NOT EXISTS idx_billing_control_windows_scope
	ON control_windows (project_id, customer_id, control_policy_id, window_start_at DESC);

CREATE TABLE IF NOT EXISTS reservation_control_holds (
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	reservation_id UUID NOT NULL REFERENCES reservations(id) ON DELETE CASCADE,
	control_window_id BIGINT NOT NULL REFERENCES control_windows(id) ON DELETE RESTRICT,
	held_value NUMERIC(38, 9) NOT NULL CHECK (held_value >= 0),
	consumed_value NUMERIC(38, 9) NOT NULL DEFAULT 0 CHECK (consumed_value >= 0),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, reservation_id, control_window_id),
	CONSTRAINT reservation_control_holds_project_reservation_fk
		FOREIGN KEY (project_id, reservation_id)
		REFERENCES reservations(project_id, id) ON DELETE CASCADE,
	CONSTRAINT reservation_control_holds_project_window_fk
		FOREIGN KEY (project_id, control_window_id)
		REFERENCES control_windows(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_billing_reservation_control_holds_window
	ON reservation_control_holds (project_id, control_window_id);

CREATE TABLE IF NOT EXISTS usage_event_control_entries (
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	usage_event_recorded_at TIMESTAMPTZ NOT NULL,
	usage_event_id UUID NOT NULL,
	control_window_id BIGINT NOT NULL REFERENCES control_windows(id) ON DELETE RESTRICT,
	-- Zero-valued entries preserve the control association for later usage corrections.
	value NUMERIC(38, 9) NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, usage_event_recorded_at, usage_event_id, control_window_id),
	CONSTRAINT usage_event_control_entries_event_fk
		FOREIGN KEY (usage_event_recorded_at, usage_event_id)
		REFERENCES usage_events(recorded_at, id) ON DELETE CASCADE,
	CONSTRAINT usage_event_control_entries_project_window_fk
		FOREIGN KEY (project_id, control_window_id)
		REFERENCES control_windows(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_billing_usage_event_control_entries_window
	ON usage_event_control_entries (project_id, control_window_id, usage_event_recorded_at);

CREATE INDEX IF NOT EXISTS idx_billing_usage_event_control_entries_event
	ON usage_event_control_entries (usage_event_recorded_at, usage_event_id);

CREATE TABLE IF NOT EXISTS usage_alerts (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	threshold_type TEXT NOT NULL CHECK (threshold_type IN ('absolute', 'percentage')),
	threshold_value NUMERIC(38, 9) NOT NULL CHECK (threshold_value > 0),
	interval TEXT NOT NULL CHECK (interval IN ('month', 'year', 'lifetime')),
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT usage_alerts_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT usage_alerts_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT usage_alerts_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id) ON DELETE CASCADE,
	CONSTRAINT usage_alerts_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT usage_alerts_percentage_check CHECK (
		threshold_type <> 'percentage' OR threshold_value <= 100
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_usage_alerts_scope
	ON usage_alerts (project_id, customer_id, feature_id, entity_id)
	WHERE active = true;

CREATE TABLE IF NOT EXISTS usage_alert_states (
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	alert_id BIGINT NOT NULL REFERENCES usage_alerts(id) ON DELETE CASCADE,
	window_start_at TIMESTAMPTZ NOT NULL,
	window_end_at TIMESTAMPTZ,
	current_value NUMERIC(38, 9) NOT NULL DEFAULT 0,
	threshold_value NUMERIC(38, 9) NOT NULL,
	crossed BOOLEAN NOT NULL DEFAULT false,
	crossing_sequence INTEGER NOT NULL DEFAULT 0 CHECK (crossing_sequence >= 0),
	last_evaluated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, alert_id),
	CONSTRAINT usage_alert_states_project_alert_fk FOREIGN KEY (project_id, alert_id)
		REFERENCES usage_alerts(project_id, id) ON DELETE CASCADE,
	CONSTRAINT usage_alert_states_bounds_check CHECK (
		window_end_at IS NULL OR window_end_at > window_start_at
	)
);

CREATE TABLE IF NOT EXISTS usage_alert_events (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	alert_id BIGINT NOT NULL REFERENCES usage_alerts(id) ON DELETE CASCADE,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE SET NULL,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	window_start_at TIMESTAMPTZ NOT NULL,
	crossing_sequence INTEGER NOT NULL CHECK (crossing_sequence > 0),
	current_value NUMERIC(38, 9) NOT NULL,
	threshold_value NUMERIC(38, 9) NOT NULL,
	event_type TEXT NOT NULL CHECK (event_type IN ('threshold_crossed', 'threshold_rearmed')),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT usage_alert_events_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT usage_alert_events_crossing_unique UNIQUE (
		project_id, alert_id, window_start_at, crossing_sequence, event_type
	),
	CONSTRAINT usage_alert_events_project_alert_fk FOREIGN KEY (project_id, alert_id)
		REFERENCES usage_alerts(project_id, id) ON DELETE CASCADE,
	CONSTRAINT usage_alert_events_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_billing_usage_alert_events_customer
	ON usage_alert_events (project_id, customer_id, created_at DESC);

CREATE TABLE IF NOT EXISTS auto_topup_policies (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entity_id BIGINT REFERENCES entities(id) ON DELETE CASCADE,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	topup_option_id BIGINT NOT NULL REFERENCES topup_options(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	threshold_quantity NUMERIC(28, 9) NOT NULL CHECK (threshold_quantity >= 0),
	cooldown_seconds INTEGER NOT NULL DEFAULT 30 CHECK (cooldown_seconds BETWEEN 30 AND 86400),
	limit_interval_seconds INTEGER NOT NULL DEFAULT 86400 CHECK (limit_interval_seconds >= 60),
	max_purchases_per_interval INTEGER NOT NULL DEFAULT 3 CHECK (max_purchases_per_interval > 0),
	max_spend_minor BIGINT CHECK (max_spend_minor IS NULL OR max_spend_minor > 0),
	max_consecutive_failures INTEGER NOT NULL DEFAULT 3 CHECK (max_consecutive_failures > 0),
	active BOOLEAN NOT NULL DEFAULT true,
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT auto_topup_policies_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT auto_topup_policies_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT auto_topup_policies_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id) ON DELETE CASCADE,
	CONSTRAINT auto_topup_policies_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT auto_topup_policies_project_option_fk FOREIGN KEY (project_id, topup_option_id)
		REFERENCES topup_options(project_id, id) ON DELETE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_auto_topup_policies_scope
	ON auto_topup_policies (
		project_id, customer_id, feature_id, COALESCE(entity_id, 0::bigint)
	);

CREATE TABLE IF NOT EXISTS auto_topup_states (
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	policy_id BIGINT NOT NULL REFERENCES auto_topup_policies(id) ON DELETE CASCADE,
	status TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'cooldown', 'suspended')),
	interval_started_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	purchases_in_interval INTEGER NOT NULL DEFAULT 0 CHECK (purchases_in_interval >= 0),
	spend_minor_in_interval BIGINT NOT NULL DEFAULT 0 CHECK (spend_minor_in_interval >= 0),
	consecutive_failures INTEGER NOT NULL DEFAULT 0 CHECK (consecutive_failures >= 0),
	cooldown_until TIMESTAMPTZ,
	circuit_opened_at TIMESTAMPTZ,
	last_attempt_at TIMESTAMPTZ,
	last_success_at TIMESTAMPTZ,
	last_error TEXT,
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	PRIMARY KEY (project_id, policy_id),
	CONSTRAINT auto_topup_states_project_policy_fk FOREIGN KEY (project_id, policy_id)
		REFERENCES auto_topup_policies(project_id, id) ON DELETE CASCADE,
	CONSTRAINT auto_topup_states_shape_check CHECK (
		(status = 'suspended' AND circuit_opened_at IS NOT NULL)
		OR (status <> 'suspended' AND circuit_opened_at IS NULL)
	)
);

CREATE TABLE IF NOT EXISTS auto_topup_jobs (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	policy_id BIGINT NOT NULL REFERENCES auto_topup_policies(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	store_product_id UUID NOT NULL REFERENCES store_products(id) ON DELETE RESTRICT,
	trigger_key TEXT COLLATE "C" NOT NULL CHECK (char_length(trigger_key) BETWEEN 1 AND 256),
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	provider_account_id TEXT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (
		status IN ('pending', 'processing', 'succeeded', 'failed', 'provider_action_required')
	),
	amount_minor BIGINT CHECK (amount_minor IS NULL OR amount_minor >= 0),
	charged_amount_minor BIGINT CHECK (charged_amount_minor IS NULL OR charged_amount_minor >= 0),
	currency TEXT COLLATE "C",
	external_invoice_id TEXT,
	external_payment_id TEXT,
	budget_reserved_at TIMESTAMPTZ,
	budget_interval_started_at TIMESTAMPTZ,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	last_error TEXT,
	completed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT auto_topup_jobs_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT auto_topup_jobs_trigger_unique UNIQUE (project_id, policy_id, trigger_key),
	CONSTRAINT auto_topup_jobs_project_policy_fk FOREIGN KEY (project_id, policy_id)
		REFERENCES auto_topup_policies(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT auto_topup_jobs_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT auto_topup_jobs_project_store_product_fk FOREIGN KEY (project_id, store_product_id)
		REFERENCES store_products(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT auto_topup_jobs_state_check CHECK (
		(status = 'succeeded' AND completed_at IS NOT NULL
			AND charged_amount_minor IS NOT NULL AND external_invoice_id IS NOT NULL)
		OR (status IN ('failed', 'provider_action_required')
			AND completed_at IS NOT NULL AND last_error IS NOT NULL)
		OR (status IN ('pending', 'processing') AND completed_at IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_jobs_due
	ON auto_topup_jobs (next_attempt_at, created_at)
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_jobs_stale
	ON auto_topup_jobs (locked_at, created_at)
	WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_jobs_policy
	ON auto_topup_jobs (policy_id);

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_jobs_customer
	ON auto_topup_jobs (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_auto_topup_jobs_store_product
	ON auto_topup_jobs (store_product_id);

CREATE TABLE IF NOT EXISTS catalog_migration_drafts (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	from_plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	to_plan_version_id BIGINT NOT NULL REFERENCES plan_versions(id) ON DELETE RESTRICT,
	preview_token TEXT COLLATE "C" NOT NULL CHECK (char_length(preview_token) = 64),
	intent_hash TEXT COLLATE "C" NOT NULL CHECK (char_length(intent_hash) = 64),
	effective_mode TEXT NOT NULL CHECK (effective_mode IN ('immediate', 'period_end')),
	status TEXT NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed', 'published', 'expired')),
	impact JSONB NOT NULL CHECK (jsonb_typeof(impact) = 'object'),
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	expires_at TIMESTAMPTZ NOT NULL,
	published_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT catalog_migration_drafts_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT catalog_migration_drafts_token_unique UNIQUE (project_id, preview_token),
	CONSTRAINT catalog_migration_drafts_project_from_fk FOREIGN KEY (project_id, from_plan_version_id)
		REFERENCES plan_versions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT catalog_migration_drafts_project_to_fk FOREIGN KEY (project_id, to_plan_version_id)
		REFERENCES plan_versions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT catalog_migration_drafts_distinct_check CHECK (from_plan_version_id <> to_plan_version_id),
	CONSTRAINT catalog_migration_drafts_publish_check CHECK (
		(status = 'published' AND published_at IS NOT NULL)
		OR (status <> 'published' AND published_at IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_catalog_migration_drafts_expiry
	ON catalog_migration_drafts (status, expires_at);

CREATE TABLE IF NOT EXISTS catalog_migration_jobs (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	draft_id UUID NOT NULL REFERENCES catalog_migration_drafts(id) ON DELETE RESTRICT,
	subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
	subscription_change_id UUID REFERENCES subscription_changes(id) ON DELETE SET NULL,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (
		status IN ('pending', 'processing', 'waiting_provider', 'applied', 'failed', 'skipped')
	),
	effective_mode TEXT NOT NULL CHECK (effective_mode IN ('immediate', 'period_end')),
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	last_error TEXT,
	applied_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT catalog_migration_jobs_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT catalog_migration_jobs_subscription_unique UNIQUE (project_id, draft_id, subscription_id),
	CONSTRAINT catalog_migration_jobs_project_draft_fk FOREIGN KEY (project_id, draft_id)
		REFERENCES catalog_migration_drafts(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT catalog_migration_jobs_project_subscription_fk FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id) ON DELETE CASCADE,
	CONSTRAINT catalog_migration_jobs_project_change_fk FOREIGN KEY (project_id, subscription_change_id)
		REFERENCES subscription_changes(project_id, id) ON DELETE SET NULL,
	CONSTRAINT catalog_migration_jobs_state_check CHECK (
		(status = 'applied' AND applied_at IS NOT NULL AND last_error IS NULL)
		OR (status IN ('failed', 'skipped') AND applied_at IS NULL AND last_error IS NOT NULL)
		OR (status = 'waiting_provider' AND applied_at IS NULL AND subscription_change_id IS NOT NULL)
		OR (status IN ('pending', 'processing') AND applied_at IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_catalog_migration_jobs_due
	ON catalog_migration_jobs (next_attempt_at, created_at)
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_catalog_migration_jobs_stale
	ON catalog_migration_jobs (locked_at, created_at)
	WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_billing_catalog_migration_jobs_change
	ON catalog_migration_jobs (subscription_change_id)
	WHERE subscription_change_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS license_pools (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	subscription_id UUID NOT NULL REFERENCES subscriptions(id) ON DELETE CASCADE,
	plan_item_id BIGINT NOT NULL REFERENCES plan_items(id) ON DELETE RESTRICT,
	feature_id BIGINT NOT NULL REFERENCES features(id) ON DELETE RESTRICT,
	quantity INTEGER NOT NULL CHECK (quantity > 0),
	active BOOLEAN NOT NULL DEFAULT true,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT license_pools_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT license_pools_item_unique UNIQUE (project_id, subscription_id, plan_item_id),
	CONSTRAINT license_pools_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT license_pools_project_subscription_fk FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id) ON DELETE CASCADE,
	CONSTRAINT license_pools_project_plan_item_fk FOREIGN KEY (project_id, plan_item_id)
		REFERENCES plan_items(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT license_pools_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_billing_license_pools_customer
	ON license_pools (project_id, customer_id, active);

CREATE TABLE IF NOT EXISTS license_assignments (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	license_pool_id BIGINT NOT NULL REFERENCES license_pools(id) ON DELETE CASCADE,
	entity_id BIGINT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
	quantity INTEGER NOT NULL DEFAULT 1 CHECK (quantity > 0),
	assigned_by TEXT NOT NULL CHECK (char_length(assigned_by) BETWEEN 1 AND 200),
	assigned_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	revoked_at TIMESTAMPTZ,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
	CONSTRAINT license_assignments_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT license_assignments_project_pool_fk FOREIGN KEY (project_id, license_pool_id)
		REFERENCES license_pools(project_id, id) ON DELETE CASCADE,
	CONSTRAINT license_assignments_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id) ON DELETE CASCADE,
	CONSTRAINT license_assignments_bounds_check CHECK (revoked_at IS NULL OR revoked_at >= assigned_at)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_license_assignments_active
	ON license_assignments (project_id, license_pool_id, entity_id)
	WHERE revoked_at IS NULL;

CREATE INDEX IF NOT EXISTS idx_billing_license_assignments_entity
	ON license_assignments (project_id, entity_id)
	WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS commercial_action_previews (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	billing_account_id TEXT COLLATE "C" NOT NULL CHECK (char_length(billing_account_id) BETWEEN 1 AND 200),
	preview_token UUID NOT NULL,
	intent_kind TEXT NOT NULL CHECK (
		intent_kind IN ('checkout_plan', 'checkout_product', 'subscription_change', 'cancel', 'uncancel', 'setup_payment')
	),
	intent_hash TEXT NOT NULL CHECK (char_length(intent_hash) = 64),
	state_fingerprint TEXT NOT NULL CHECK (char_length(state_fingerprint) = 64),
	intent JSONB NOT NULL CHECK (jsonb_typeof(intent) = 'object'),
	preview JSONB NOT NULL CHECK (jsonb_typeof(preview) = 'object'),
	status TEXT NOT NULL DEFAULT 'previewed' CHECK (
		status IN ('previewed', 'executing', 'executed')
	),
	execution_idempotency_key TEXT CHECK (
		execution_idempotency_key IS NULL
		OR char_length(execution_idempotency_key) BETWEEN 1 AND 200
	),
	execution_result JSONB CHECK (
		execution_result IS NULL OR jsonb_typeof(execution_result) = 'object'
	),
	expires_at TIMESTAMPTZ NOT NULL,
	executed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT commercial_action_previews_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT commercial_action_previews_project_token_unique UNIQUE (project_id, preview_token),
	CONSTRAINT commercial_action_previews_state_check CHECK (
		(status = 'previewed' AND execution_idempotency_key IS NULL AND execution_result IS NULL AND executed_at IS NULL)
		OR (status = 'executing' AND execution_idempotency_key IS NOT NULL AND execution_result IS NULL AND executed_at IS NULL)
		OR (status = 'executed' AND execution_idempotency_key IS NOT NULL AND execution_result IS NOT NULL AND executed_at IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_commercial_previews_expiry
	ON commercial_action_previews (expires_at)
	WHERE status = 'previewed';

CREATE INDEX IF NOT EXISTS idx_billing_commercial_previews_account_created
	ON commercial_action_previews (project_id, billing_account_id, created_at DESC);

-- Hosted payment-method setup. A setup saves a method for later off-session charges; it records no
-- purchase, allocation, entitlement or invoice, and the only provider state it changes is which
-- payment method the customer is charged by default.
CREATE TABLE IF NOT EXISTS payment_setup_sessions (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	billing_account_id TEXT COLLATE "C" NOT NULL CHECK (char_length(billing_account_id) BETWEEN 1 AND 200),
	provider TEXT NOT NULL CHECK (provider = 'stripe'),
	-- Copied from the connection that created the setup, so recovery picks the same account after a rotation.
	provider_account_id TEXT,
	provider_customer_id TEXT NOT NULL CHECK (char_length(provider_customer_id) BETWEEN 1 AND 200),
	preview_token UUID NOT NULL,
	-- The exact provider idempotency key the creation call used, so a crashed creation resumes it.
	provider_idempotency_key TEXT NOT NULL CHECK (char_length(provider_idempotency_key) BETWEEN 1 AND 255),
	-- The frozen request parameters, hashed: a differing request conflicts instead of reusing the link.
	request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
	currency TEXT NOT NULL CHECK (currency ~ '^[a-z]{3}$'),
	email TEXT CHECK (email IS NULL OR char_length(email) BETWEEN 1 AND 320),
	success_url TEXT NOT NULL CHECK (char_length(success_url) BETWEEN 1 AND 2000),
	cancel_url TEXT NOT NULL CHECK (char_length(cancel_url) BETWEEN 1 AND 2000),
	status TEXT NOT NULL DEFAULT 'creating' CHECK (
		status IN ('creating', 'awaiting_customer', 'applying_default', 'completed', 'expired', 'needs_attention')
	),
	external_session_id TEXT CHECK (external_session_id IS NULL OR char_length(external_session_id) BETWEEN 1 AND 200),
	session_url TEXT,
	external_setup_intent_id TEXT,
	-- Written before the provider default-method call, so a crashed apply retries the same intent.
	intended_payment_method_id TEXT,
	-- Written only once the provider confirmed the default-method update.
	default_payment_method_id TEXT,
	card_brand TEXT CHECK (card_brand IS NULL OR char_length(card_brand) BETWEEN 1 AND 40),
	card_last4 TEXT CHECK (card_last4 IS NULL OR card_last4 ~ '^[0-9]{4}$'),
	card_exp_month INTEGER CHECK (card_exp_month IS NULL OR card_exp_month BETWEEN 1 AND 12),
	card_exp_year INTEGER CHECK (card_exp_year IS NULL OR card_exp_year BETWEEN 2000 AND 2200),
	attention_reason TEXT CHECK (attention_reason IS NULL OR char_length(attention_reason) BETWEEN 1 AND 500),
	expires_at TIMESTAMPTZ NOT NULL,
	completed_at TIMESTAMPTZ,
	-- Claim protection: duplicate or out-of-order events cannot apply one setup concurrently.
	claimed_by TEXT CHECK (claimed_by IS NULL OR char_length(claimed_by) BETWEEN 1 AND 200),
	claimed_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT payment_setup_sessions_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT payment_setup_sessions_project_preview_unique UNIQUE (project_id, preview_token),
	CONSTRAINT payment_setup_sessions_project_customer_fk
		FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT payment_setup_sessions_claim_check CHECK (
		(claimed_by IS NULL AND claimed_at IS NULL) OR (claimed_by IS NOT NULL AND claimed_at IS NOT NULL)
	),
	CONSTRAINT payment_setup_sessions_state_check CHECK (
		(status = 'creating' AND completed_at IS NULL AND default_payment_method_id IS NULL)
		OR (
			status = 'awaiting_customer'
			AND external_session_id IS NOT NULL AND session_url IS NOT NULL
			AND completed_at IS NULL AND default_payment_method_id IS NULL
		)
		OR (
			status = 'applying_default'
			AND external_session_id IS NOT NULL AND intended_payment_method_id IS NOT NULL
			AND completed_at IS NULL AND default_payment_method_id IS NULL
		)
		OR (
			status = 'completed'
			AND external_session_id IS NOT NULL AND default_payment_method_id IS NOT NULL
			AND completed_at IS NOT NULL
		)
		OR (status = 'expired' AND completed_at IS NULL AND default_payment_method_id IS NULL)
		OR (status = 'needs_attention' AND attention_reason IS NOT NULL AND completed_at IS NULL)
	),
	CONSTRAINT payment_setup_sessions_card_check CHECK (
		default_payment_method_id IS NOT NULL
		OR (card_brand IS NULL AND card_last4 IS NULL AND card_exp_month IS NULL AND card_exp_year IS NULL)
	)
);

-- One unresolved setup per billing account and provider identity; completed and expired free the slot.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_setup_active
	ON payment_setup_sessions (project_id, customer_id, provider, COALESCE(provider_account_id, ''))
	WHERE status IN ('creating', 'awaiting_customer', 'applying_default', 'needs_attention');

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_payment_setup_external_session
	ON payment_setup_sessions (project_id, external_session_id)
	WHERE external_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_payment_setup_account_created
	ON payment_setup_sessions (project_id, billing_account_id, created_at DESC);

CREATE TABLE IF NOT EXISTS promotions (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	key TEXT COLLATE "C" NOT NULL CHECK (char_length(key) BETWEEN 1 AND 120),
	name TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 200),
	effect_kind TEXT NOT NULL CHECK (effect_kind IN ('discount', 'feature_grant', 'plan_grant')),
	status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'archived')),
	allowed_channels TEXT[] NOT NULL DEFAULT ARRAY['web', 'ios', 'android']::text[],
	discount_type TEXT CHECK (discount_type IS NULL OR discount_type IN ('percent', 'amount')),
	percent_off_bps INTEGER CHECK (percent_off_bps IS NULL OR percent_off_bps BETWEEN 1 AND 10000),
	discount_duration TEXT CHECK (
		discount_duration IS NULL OR discount_duration IN ('once', 'repeating', 'forever')
	),
	duration_months INTEGER CHECK (duration_months IS NULL OR duration_months BETWEEN 1 AND 36),
	plan_id BIGINT,
	grant_duration_unit TEXT CHECK (grant_duration_unit IS NULL OR grant_duration_unit IN ('day', 'month')),
	grant_duration_count INTEGER CHECK (
		grant_duration_count IS NULL OR grant_duration_count BETWEEN 1 AND 730
	),
	terms_hash TEXT COLLATE "C" NOT NULL CHECK (char_length(terms_hash) = 64),
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(metadata) = 'object'),
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	archived_by TEXT CHECK (archived_by IS NULL OR char_length(archived_by) BETWEEN 1 AND 200),
	archived_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT promotions_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotions_project_key_unique UNIQUE (project_id, key),
	CONSTRAINT promotions_project_plan_fk FOREIGN KEY (project_id, plan_id)
		REFERENCES plans(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotions_allowed_channels_check CHECK (
		cardinality(allowed_channels) BETWEEN 1 AND 3
		AND allowed_channels <@ ARRAY['web', 'ios', 'android']::text[]
	),
	CONSTRAINT promotions_effect_terms_check CHECK (
		(
			effect_kind = 'discount'
			AND discount_type IS NOT NULL
			AND discount_duration IS NOT NULL
			AND (discount_type = 'percent') = (percent_off_bps IS NOT NULL)
			AND (discount_duration = 'repeating') = (duration_months IS NOT NULL)
			AND plan_id IS NULL AND grant_duration_unit IS NULL AND grant_duration_count IS NULL
		)
		OR (
			effect_kind = 'feature_grant'
			AND discount_type IS NULL AND percent_off_bps IS NULL
			AND discount_duration IS NULL AND duration_months IS NULL
			AND plan_id IS NULL AND grant_duration_unit IS NULL AND grant_duration_count IS NULL
		)
		OR (
			effect_kind = 'plan_grant'
			AND discount_type IS NULL AND percent_off_bps IS NULL
			AND discount_duration IS NULL AND duration_months IS NULL
			AND plan_id IS NOT NULL AND grant_duration_unit IS NOT NULL
			AND grant_duration_count IS NOT NULL
		)
	),
	CONSTRAINT promotions_archive_check CHECK (
		(status = 'active' AND archived_at IS NULL AND archived_by IS NULL)
		OR (status = 'archived' AND archived_at IS NOT NULL AND archived_by IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_promotions_project_created
	ON promotions (project_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS promotion_discount_amounts (
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	currency TEXT COLLATE "C" NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
	amount_off_minor BIGINT NOT NULL CHECK (amount_off_minor > 0),
	CONSTRAINT promotion_discount_amounts_pkey PRIMARY KEY (project_id, promotion_id, currency),
	CONSTRAINT promotion_discount_amounts_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS promotion_targets (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	target_kind TEXT NOT NULL CHECK (target_kind IN ('plan', 'product')),
	plan_id BIGINT,
	product_id UUID,
	CONSTRAINT promotion_targets_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotion_targets_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_targets_project_plan_fk FOREIGN KEY (project_id, plan_id)
		REFERENCES plans(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_targets_project_product_fk FOREIGN KEY (project_id, product_id)
		REFERENCES products(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_targets_shape_check CHECK (
		(target_kind = 'plan' AND plan_id IS NOT NULL AND product_id IS NULL)
		OR (target_kind = 'product' AND product_id IS NOT NULL AND plan_id IS NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_targets_plan
	ON promotion_targets (project_id, promotion_id, plan_id)
	WHERE plan_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_targets_product
	ON promotion_targets (project_id, promotion_id, product_id)
	WHERE product_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotion_grant_items (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	feature_id BIGINT NOT NULL,
	quantity NUMERIC(28, 9) NOT NULL CHECK (quantity > 0),
	expires_after_seconds BIGINT CHECK (expires_after_seconds IS NULL OR expires_after_seconds > 0),
	CONSTRAINT promotion_grant_items_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotion_grant_items_project_feature_unique UNIQUE (project_id, promotion_id, feature_id),
	CONSTRAINT promotion_grant_items_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_grant_items_project_feature_fk FOREIGN KEY (project_id, feature_id)
		REFERENCES features(project_id, id) ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS promotion_codes (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	code TEXT COLLATE "C" NOT NULL CHECK (code ~ '^[A-Za-z0-9-]{3,64}$'),
	normalized_code TEXT COLLATE "C" NOT NULL CHECK (normalized_code ~ '^[A-Z0-9-]{3,64}$'),
	active BOOLEAN NOT NULL DEFAULT true,
	starts_at TIMESTAMPTZ,
	expires_at TIMESTAMPTZ,
	max_redemptions INTEGER CHECK (max_redemptions IS NULL OR max_redemptions > 0),
	max_redemptions_per_customer INTEGER CHECK (
		max_redemptions_per_customer IS NULL OR max_redemptions_per_customer > 0
	),
	first_purchase_only BOOLEAN NOT NULL DEFAULT false,
	billing_account_id TEXT COLLATE "C" CHECK (
		billing_account_id IS NULL OR char_length(billing_account_id) BETWEEN 1 AND 200
	),
	hosted_checkout_enabled BOOLEAN NOT NULL DEFAULT false,
	redeemed_count INTEGER NOT NULL DEFAULT 0 CHECK (redeemed_count >= 0),
	reserved_count INTEGER NOT NULL DEFAULT 0 CHECK (reserved_count >= 0),
	created_by TEXT NOT NULL CHECK (char_length(created_by) BETWEEN 1 AND 200),
	deactivated_by TEXT CHECK (deactivated_by IS NULL OR char_length(deactivated_by) BETWEEN 1 AND 200),
	deactivated_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT promotion_codes_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotion_codes_project_code_unique UNIQUE (project_id, normalized_code),
	CONSTRAINT promotion_codes_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_codes_normalized_check CHECK (normalized_code = upper(code)),
	CONSTRAINT promotion_codes_window_check CHECK (
		starts_at IS NULL OR expires_at IS NULL OR expires_at > starts_at
	),
	CONSTRAINT promotion_codes_deactivation_check CHECK (
		(active AND deactivated_at IS NULL AND deactivated_by IS NULL)
		OR (NOT active AND deactivated_at IS NOT NULL AND deactivated_by IS NOT NULL)
	),
	-- Stripe cannot enforce a per-customer cap or an account restriction on hosted entry.
	CONSTRAINT promotion_codes_hosted_check CHECK (
		NOT hosted_checkout_enabled
		OR (billing_account_id IS NULL AND max_redemptions_per_customer IS NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_promotion_codes_promotion_created
	ON promotion_codes (project_id, promotion_id, created_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS promotion_provider_objects (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	promotion_code_id UUID,
	parent_object_id UUID,
	provider TEXT NOT NULL CHECK (provider IN ('stripe', 'apple', 'google')),
	object_kind TEXT NOT NULL CHECK (
		object_kind IN (
			'coupon',
			'promotion_code',
			'apple_promotional_offer',
			'apple_offer_code',
			'google_developer_offer',
			'google_promo_code'
		)
	),
	external_id TEXT COLLATE "C" CHECK (external_id IS NULL OR char_length(external_id) BETWEEN 1 AND 255),
	product_external_id TEXT COLLATE "C" CHECK (
		product_external_id IS NULL OR char_length(product_external_id) BETWEEN 1 AND 255
	),
	base_plan_id TEXT COLLATE "C" CHECK (base_plan_id IS NULL OR char_length(base_plan_id) BETWEEN 1 AND 255),
	redemption_code TEXT COLLATE "C" CHECK (
		redemption_code IS NULL OR char_length(redemption_code) BETWEEN 1 AND 255
	),
	applies_to JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(applies_to) = 'object'),
	applies_to_hash TEXT COLLATE "C" CHECK (applies_to_hash IS NULL OR char_length(applies_to_hash) = 64),
	catalog_revision_id BIGINT,
	status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'ready', 'failed', 'retired')),
	desired_active BOOLEAN NOT NULL DEFAULT true,
	desired_generation INTEGER NOT NULL DEFAULT 0 CHECK (desired_generation >= 0),
	provider_active BOOLEAN,
	retire_requested BOOLEAN NOT NULL DEFAULT false,
	attempts INTEGER NOT NULL DEFAULT 0 CHECK (attempts >= 0),
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	locked_at TIMESTAMPTZ,
	locked_by TEXT CHECK (locked_by IS NULL OR char_length(locked_by) BETWEEN 1 AND 200),
	error TEXT CHECK (error IS NULL OR char_length(error) <= 2000),
	ready_at TIMESTAMPTZ,
	retired_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT promotion_provider_objects_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotion_provider_objects_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_provider_objects_project_code_fk FOREIGN KEY (project_id, promotion_code_id)
		REFERENCES promotion_codes(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_provider_objects_project_parent_fk FOREIGN KEY (project_id, parent_object_id)
		REFERENCES promotion_provider_objects(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_provider_objects_project_revision_fk FOREIGN KEY (project_id, catalog_revision_id)
		REFERENCES catalog_revisions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_provider_objects_shape_check CHECK (
		(
			object_kind = 'coupon' AND provider = 'stripe'
			AND promotion_code_id IS NULL AND parent_object_id IS NULL AND applies_to_hash IS NOT NULL
		)
		OR (
			object_kind = 'promotion_code' AND provider = 'stripe'
			AND promotion_code_id IS NOT NULL AND parent_object_id IS NOT NULL
		)
		OR (
			object_kind IN ('apple_promotional_offer', 'apple_offer_code') AND provider = 'apple'
			AND parent_object_id IS NULL AND external_id IS NOT NULL AND product_external_id IS NOT NULL
		)
		OR (
			object_kind IN ('google_developer_offer', 'google_promo_code') AND provider = 'google'
			AND parent_object_id IS NULL AND product_external_id IS NOT NULL
			AND (external_id IS NOT NULL OR redemption_code IS NOT NULL)
		)
	),
	CONSTRAINT promotion_provider_objects_state_check CHECK (
		(status <> 'ready' OR (external_id IS NOT NULL OR redemption_code IS NOT NULL) AND ready_at IS NOT NULL)
		AND (status <> 'failed' OR error IS NOT NULL)
		AND (status <> 'retired' OR retired_at IS NOT NULL)
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_provider_objects_coupon
	ON promotion_provider_objects (project_id, promotion_id, provider, applies_to_hash)
	WHERE object_kind = 'coupon' AND status <> 'retired';

-- One live Stripe promotion code per Quotum code: Stripe requires active codes to be unique, so
-- a replacement can only be created after the previous object is retired.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_provider_objects_live_code
	ON promotion_provider_objects (project_id, promotion_code_id, provider)
	WHERE object_kind = 'promotion_code' AND status <> 'retired';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_provider_objects_external
	ON promotion_provider_objects (project_id, provider, object_kind, external_id)
	WHERE external_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_promotion_provider_objects_promotion
	ON promotion_provider_objects (project_id, promotion_id, created_at);

CREATE INDEX IF NOT EXISTS idx_billing_promotion_provider_objects_due
	ON promotion_provider_objects (next_attempt_at, id)
	WHERE status = 'pending' OR (status = 'ready' AND provider_active IS DISTINCT FROM desired_active);

CREATE TABLE IF NOT EXISTS promotion_redemptions (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	promotion_code_id UUID,
	customer_id UUID NOT NULL,
	channel TEXT NOT NULL CHECK (channel IN ('web', 'ios', 'android')),
	status TEXT NOT NULL CHECK (status IN ('reserved', 'applied', 'released', 'reversed')),
	provider TEXT NOT NULL CHECK (provider IN ('quotum', 'stripe', 'apple', 'google')),
	source TEXT NOT NULL CHECK (
		source IN ('api_redeem', 'commercial_action', 'stripe_hosted_checkout', 'apple_offer', 'google_offer')
	),
	commercial_action_preview_id UUID,
	subscription_change_id UUID,
	purchase_id UUID,
	provider_object_id UUID,
	stripe_coupon_id TEXT COLLATE "C",
	stripe_promotion_code_id TEXT COLLATE "C",
	stripe_checkout_session_id TEXT COLLATE "C",
	stripe_invoice_id TEXT COLLATE "C",
	external_subscription_id TEXT COLLATE "C",
	provider_subscription_ref TEXT COLLATE "C",
	provider_transaction_id TEXT COLLATE "C",
	provider_offer_type TEXT COLLATE "C",
	last_observed_transaction_id TEXT COLLATE "C",
	last_observed_at TIMESTAMPTZ,
	currency TEXT COLLATE "C" CHECK (currency IS NULL OR currency ~ '^[A-Z]{3}$'),
	amount_subtotal_minor BIGINT CHECK (amount_subtotal_minor IS NULL OR amount_subtotal_minor >= 0),
	amount_discount_minor BIGINT CHECK (amount_discount_minor IS NULL OR amount_discount_minor >= 0),
	amount_total_minor BIGINT CHECK (amount_total_minor IS NULL OR amount_total_minor >= 0),
	effect_snapshot JSONB NOT NULL CHECK (jsonb_typeof(effect_snapshot) = 'object'),
	result JSONB CHECK (
		result IS NULL OR (jsonb_typeof(result) = 'object' AND octet_length(result::text) <= 16384)
	),
	limit_violation TEXT CHECK (
		limit_violation IS NULL
		OR limit_violation IN ('global', 'first_purchase', 'not_applicable', 'inactive', 'expired')
	),
	actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200),
	reason TEXT CHECK (reason IS NULL OR char_length(reason) BETWEEN 1 AND 500),
	idempotency_key TEXT COLLATE "C" NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
	request_hash TEXT COLLATE "C" NOT NULL CHECK (char_length(request_hash) = 64),
	reserved_until TIMESTAMPTZ,
	applied_at TIMESTAMPTZ,
	released_at TIMESTAMPTZ,
	reversed_at TIMESTAMPTZ,
	reversal_actor TEXT CHECK (reversal_actor IS NULL OR char_length(reversal_actor) BETWEEN 1 AND 200),
	reversal_reason TEXT CHECK (reversal_reason IS NULL OR char_length(reversal_reason) BETWEEN 1 AND 500),
	reversal_idempotency_key TEXT COLLATE "C" CHECK (
		reversal_idempotency_key IS NULL OR char_length(reversal_idempotency_key) BETWEEN 1 AND 255
	),
	reversal_request_hash TEXT COLLATE "C" CHECK (
		reversal_request_hash IS NULL OR char_length(reversal_request_hash) = 64
	),
	reversal_result JSONB CHECK (
		reversal_result IS NULL
		OR (jsonb_typeof(reversal_result) = 'object' AND octet_length(reversal_result::text) <= 16384)
	),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT promotion_redemptions_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotion_redemptions_idempotency_unique UNIQUE (project_id, customer_id, idempotency_key),
	CONSTRAINT promotion_redemptions_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_redemptions_project_code_fk FOREIGN KEY (project_id, promotion_code_id)
		REFERENCES promotion_codes(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_redemptions_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT promotion_redemptions_project_preview_fk FOREIGN KEY (project_id, commercial_action_preview_id)
		REFERENCES commercial_action_previews(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_redemptions_project_change_fk FOREIGN KEY (project_id, subscription_change_id)
		REFERENCES subscription_changes(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_redemptions_project_purchase_fk FOREIGN KEY (project_id, purchase_id)
		REFERENCES purchases(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_redemptions_project_provider_object_fk FOREIGN KEY (project_id, provider_object_id)
		REFERENCES promotion_provider_objects(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_redemptions_code_required_check CHECK (
		promotion_code_id IS NOT NULL OR source IN ('apple_offer', 'google_offer')
	),
	CONSTRAINT promotion_redemptions_state_check CHECK (
		(status = 'reserved' AND reserved_until IS NOT NULL AND applied_at IS NULL AND released_at IS NULL AND reversed_at IS NULL)
		OR (status = 'applied' AND applied_at IS NOT NULL AND reversed_at IS NULL)
		OR (status = 'released' AND released_at IS NOT NULL AND applied_at IS NULL AND reversed_at IS NULL)
		OR (status = 'reversed' AND applied_at IS NOT NULL AND reversed_at IS NOT NULL)
	)
);

CREATE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_code_customer
	ON promotion_redemptions (project_id, promotion_code_id, customer_id)
	WHERE status IN ('reserved', 'applied', 'reversed');

CREATE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_reserved_expiry
	ON promotion_redemptions (reserved_until, id)
	WHERE status = 'reserved';

CREATE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_promotion_created
	ON promotion_redemptions (project_id, promotion_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_customer_created
	ON promotion_redemptions (project_id, customer_id, created_at DESC, id DESC);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_checkout_session
	ON promotion_redemptions (project_id, stripe_checkout_session_id)
	WHERE stripe_checkout_session_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_subscription_change
	ON promotion_redemptions (project_id, subscription_change_id)
	WHERE subscription_change_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_promotion_redemptions_purchase
	ON promotion_redemptions (project_id, purchase_id)
	WHERE purchase_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS promotion_audit_events (
	id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	promotion_id UUID NOT NULL,
	promotion_code_id UUID,
	action TEXT NOT NULL CHECK (
		action IN (
			'promotion_created',
			'promotion_archived',
			'codes_added',
			'code_deactivated',
			'provider_mapping_added',
			'provider_sync_requested'
		)
	),
	actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200),
	details JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT promotion_audit_events_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT promotion_audit_events_project_promotion_fk FOREIGN KEY (project_id, promotion_id)
		REFERENCES promotions(project_id, id) ON DELETE RESTRICT,
	CONSTRAINT promotion_audit_events_project_code_fk FOREIGN KEY (project_id, promotion_code_id)
		REFERENCES promotion_codes(project_id, id) ON DELETE RESTRICT
);

CREATE INDEX IF NOT EXISTS idx_billing_promotion_audit_events_promotion_created
	ON promotion_audit_events (project_id, promotion_id, created_at DESC);

-- A plan grant holds a published plan version for a fixed time without a payment provider. It is
-- its own access source, never a subscription; a trial is its first origin. Its allowances are
-- `reward` allocations linked to it, and none outlives it.
CREATE TABLE IF NOT EXISTS plan_grants (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL,
	plan_id BIGINT NOT NULL,
	plan_version_id BIGINT NOT NULL,
	-- The pinned version's kind, kept here so the one-active-base-grant index can use it.
	plan_kind TEXT NOT NULL CHECK (plan_kind IN ('base', 'addon')),
	origin TEXT NOT NULL CHECK (origin IN ('trial')),
	status TEXT NOT NULL CHECK (status IN ('active', 'expired', 'ended', 'superseded')),
	duration_unit TEXT NOT NULL CHECK (duration_unit IN ('day', 'month')),
	duration_count INTEGER NOT NULL CHECK (duration_count BETWEEN 1 AND 730),
	starts_at TIMESTAMPTZ NOT NULL,
	ends_at TIMESTAMPTZ NOT NULL,
	ended_at TIMESTAMPTZ,
	-- Copied at start from the version's published bindings, so a later publish cannot move them.
	entitlement_keys TEXT[] NOT NULL DEFAULT ARRAY[]::text[],
	-- Start of the next reset window whose allowances are not materialized yet.
	next_period_at TIMESTAMPTZ,
	ending_notified_at TIMESTAMPTZ,
	superseded_by_subscription_id UUID,
	actor TEXT NOT NULL CHECK (char_length(actor) BETWEEN 1 AND 200),
	end_actor TEXT CHECK (end_actor IS NULL OR char_length(end_actor) BETWEEN 1 AND 200),
	end_reason TEXT CHECK (end_reason IS NULL OR char_length(end_reason) BETWEEN 1 AND 500),
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb CHECK (
		jsonb_typeof(metadata) = 'object' AND octet_length(metadata::text) <= 4096
	),
	idempotency_key TEXT COLLATE "C" NOT NULL CHECK (char_length(idempotency_key) BETWEEN 1 AND 255),
	request_hash TEXT COLLATE "C" NOT NULL CHECK (char_length(request_hash) = 64),
	end_idempotency_key TEXT COLLATE "C" CHECK (
		end_idempotency_key IS NULL OR char_length(end_idempotency_key) BETWEEN 1 AND 255
	),
	end_request_hash TEXT COLLATE "C" CHECK (
		end_request_hash IS NULL OR char_length(end_request_hash) = 64
	),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT plan_grants_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT plan_grants_idempotency_unique UNIQUE (project_id, customer_id, idempotency_key),
	CONSTRAINT plan_grants_project_customer_fk FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT plan_grants_project_plan_fk FOREIGN KEY (project_id, plan_id)
		REFERENCES plans(project_id, id),
	CONSTRAINT plan_grants_project_plan_version_fk FOREIGN KEY (project_id, plan_version_id)
		REFERENCES plan_versions(project_id, id),
	CONSTRAINT plan_grants_project_superseding_subscription_fk
		FOREIGN KEY (project_id, superseded_by_subscription_id)
		REFERENCES subscriptions(project_id, id),
	CONSTRAINT plan_grants_bounds_check CHECK (
		starts_at < ends_at AND (ended_at IS NULL OR (ended_at >= starts_at AND ended_at <= ends_at))
	),
	CONSTRAINT plan_grants_entitlement_keys_check CHECK (
		cardinality(entitlement_keys) <= 100 AND array_position(entitlement_keys, NULL) IS NULL
	),
	CONSTRAINT plan_grants_trial_duration_check CHECK (origin <> 'trial' OR duration_unit = 'day'),
	CONSTRAINT plan_grants_end_key_check CHECK (
		(end_idempotency_key IS NULL) = (end_request_hash IS NULL)
	),
	CONSTRAINT plan_grants_state_check CHECK (
		(status = 'active' AND ended_at IS NULL AND superseded_by_subscription_id IS NULL
			AND end_idempotency_key IS NULL)
		OR (status = 'expired' AND ended_at = ends_at AND superseded_by_subscription_id IS NULL
			AND next_period_at IS NULL)
		OR (status = 'ended' AND ended_at < ends_at AND end_idempotency_key IS NOT NULL
			AND superseded_by_subscription_id IS NULL AND next_period_at IS NULL)
		OR (status = 'superseded' AND ended_at IS NOT NULL
			AND superseded_by_subscription_id IS NOT NULL AND next_period_at IS NULL)
	)
);

-- A base grant is refused while another base grant is active.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_plan_grants_one_active_base
	ON plan_grants (project_id, customer_id)
	WHERE status = 'active' AND plan_kind = 'base';

-- An account trials a plan at most once, whatever became of that trial.
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_plan_grants_trial_once
	ON plan_grants (project_id, customer_id, plan_id)
	WHERE origin = 'trial';

CREATE INDEX IF NOT EXISTS idx_billing_plan_grants_customer_active
	ON plan_grants (project_id, customer_id, plan_version_id)
	WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_billing_plan_grants_due
	ON plan_grants (ends_at, id)
	WHERE status = 'active';

CREATE INDEX IF NOT EXISTS idx_billing_plan_grants_next_period
	ON plan_grants (next_period_at, id)
	WHERE status = 'active' AND next_period_at IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_plan_grants_customer_created
	ON plan_grants (project_id, customer_id, created_at DESC, id DESC);

CREATE INDEX IF NOT EXISTS idx_billing_plan_grants_superseding_subscription
	ON plan_grants (project_id, superseded_by_subscription_id)
	WHERE superseded_by_subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_usage_events_customer_feature_time
	ON usage_events (project_id, customer_id, meter_feature_id, recorded_at DESC, id DESC);

CREATE INDEX idx_client_operation_result_expiry
 ON client_idempotency_claims (result_expires_at, id)
 WHERE outcome IS NOT NULL AND completed_at IS NOT NULL;

ALTER TABLE balance_allocations
	ADD CONSTRAINT balance_allocations_project_promotion_redemption_fk
			FOREIGN KEY (project_id, promotion_redemption_id)
			REFERENCES promotion_redemptions(project_id, id)
			ON DELETE RESTRICT;

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_promotion_redemption
	ON balance_allocations (project_id, promotion_redemption_id)
	WHERE promotion_redemption_id IS NOT NULL;

ALTER TABLE balance_allocations
	ADD CONSTRAINT balance_allocations_project_plan_grant_fk
			FOREIGN KEY (project_id, plan_grant_id)
			REFERENCES plan_grants(project_id, id);

CREATE INDEX IF NOT EXISTS idx_billing_balance_allocations_plan_grant
	ON balance_allocations (project_id, plan_grant_id)
	WHERE plan_grant_id IS NOT NULL;

-- Constraints on tables defined in earlier files that reference this file's tables.
ALTER TABLE projects
	ADD CONSTRAINT projects_published_catalog_revision_fk
			FOREIGN KEY (id, published_catalog_revision_id)
			REFERENCES catalog_revisions(project_id, id)
			ON DELETE RESTRICT;

ALTER TABLE subscriptions
	ADD CONSTRAINT subscriptions_project_plan_version_fk
			FOREIGN KEY (project_id, plan_version_id)
			REFERENCES plan_versions(project_id, id)
			ON DELETE RESTRICT;

ALTER TABLE subscriptions
	ADD CONSTRAINT subscriptions_project_catalog_revision_fk
			FOREIGN KEY (project_id, catalog_revision_id)
			REFERENCES catalog_revisions(project_id, id)
			ON DELETE RESTRICT;

ALTER TABLE subscriptions
	ADD CONSTRAINT subscriptions_project_entity_fk FOREIGN KEY (project_id, entity_id)
		REFERENCES entities(project_id, id) ON DELETE RESTRICT;

ALTER TABLE entitlements
	ADD CONSTRAINT entitlements_project_plan_grant_fk
			FOREIGN KEY (project_id, source_plan_grant_id)
			REFERENCES plan_grants(project_id, id);

ALTER TABLE checkout_requests
	ADD CONSTRAINT checkout_requests_plan_version_id_fkey FOREIGN KEY (plan_version_id) REFERENCES plan_versions(id) ON DELETE RESTRICT;

ALTER TABLE plans
	ADD CONSTRAINT plans_active_version_fk
			FOREIGN KEY (project_id, active_version_id)
			REFERENCES plan_versions(project_id, id)
			ON DELETE RESTRICT;
