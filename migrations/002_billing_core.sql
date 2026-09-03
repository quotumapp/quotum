-- Baseline schema. Before 1.0 these files evolve in place; recreate databases instead of migrating.
-- Billing core: customers, products, provider purchases, subscriptions, entitlements, provider events,
-- and projection delivery.

CREATE TABLE IF NOT EXISTS customers (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	billing_account_id TEXT NOT NULL,
	email TEXT,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT customers_project_id_id_unique UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS products (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	key TEXT NOT NULL,
	entitlement_key TEXT NOT NULL,
	credit_amount INTEGER NOT NULL DEFAULT 0 CHECK (credit_amount >= 0),
	name TEXT,
	description TEXT,
	type TEXT NOT NULL CHECK (type IN ('subscription', 'consumable', 'non_consumable')),
	active BOOLEAN NOT NULL DEFAULT true,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT products_project_id_id_unique UNIQUE (project_id, id)
);

CREATE TABLE IF NOT EXISTS store_products (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	external_product_id TEXT NOT NULL,
	external_price_id TEXT,
	billing_period TEXT NOT NULL,
	currency TEXT,
	price_amount BIGINT,
	active BOOLEAN NOT NULL DEFAULT true,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT store_products_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT store_products_project_product_fk FOREIGN KEY (project_id, product_id) REFERENCES products(project_id, id)
);

CREATE TABLE IF NOT EXISTS provider_customers (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	external_customer_id TEXT NOT NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT provider_customers_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT provider_customers_project_customer_fk FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS subscriptions (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
	store_product_id UUID NOT NULL REFERENCES store_products(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	external_subscription_id TEXT NOT NULL,
	external_product_id TEXT NOT NULL,
	external_price_id TEXT,
	status TEXT NOT NULL CHECK (
		status IN ('active', 'grace_period', 'billing_retry', 'cancelled', 'expired', 'refunded', 'revoked')
	),
	starts_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	expires_at TIMESTAMPTZ,
	auto_renew BOOLEAN NOT NULL DEFAULT true,
	latest_transaction_id TEXT,
	raw_state JSONB NOT NULL DEFAULT '{}'::jsonb,
	provider_reconciliation_attempts INTEGER NOT NULL DEFAULT 0,
	provider_reconciliation_error TEXT,
	provider_reconciliation_next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	provider_reconciliation_locked_at TIMESTAMPTZ,
	provider_reconciliation_locked_by TEXT,
	provider_reconciled_at TIMESTAMPTZ,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	provider_status TEXT,
	current_period_start TIMESTAMPTZ,
	current_period_end TIMESTAMPTZ,
	cancel_at_period_end BOOLEAN NOT NULL DEFAULT false,
	latest_provider_object_id TEXT,
	last_provider_event_created BIGINT NOT NULL DEFAULT 0,
	plan_version_id BIGINT,
	catalog_revision_id BIGINT,
	trial_start_at TIMESTAMPTZ,
	trial_end_at TIMESTAMPTZ,
	billing_anchor_at TIMESTAMPTZ,
	provider_schedule_id TEXT,
	entity_id BIGINT,
	scope_mode TEXT NOT NULL DEFAULT 'account',
	CONSTRAINT subscriptions_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT subscriptions_project_customer_fk FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT subscriptions_project_product_fk FOREIGN KEY (project_id, product_id) REFERENCES products(project_id, id),
	CONSTRAINT subscriptions_project_store_product_fk FOREIGN KEY (project_id, store_product_id) REFERENCES store_products(project_id, id),
	CONSTRAINT subscriptions_trial_bounds_check CHECK (
		(trial_start_at IS NULL AND trial_end_at IS NULL)
		OR (trial_start_at IS NOT NULL AND trial_end_at IS NOT NULL AND trial_end_at > trial_start_at)
	),
	CONSTRAINT subscriptions_scope_mode_check CHECK (scope_mode IN ('account', 'entity')),
	CONSTRAINT subscriptions_scope_entity_check CHECK (
		(scope_mode = 'account' AND entity_id IS NULL)
		OR (scope_mode = 'entity' AND entity_id IS NOT NULL)
	)
);

CREATE TABLE IF NOT EXISTS purchases (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	product_id UUID NOT NULL REFERENCES products(id) ON DELETE RESTRICT,
	store_product_id UUID REFERENCES store_products(id) ON DELETE SET NULL,
	subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	purchase_kind TEXT NOT NULL CHECK (purchase_kind IN ('subscription', 'consumable', 'non_consumable')),
	transaction_id TEXT NOT NULL,
	original_transaction_id TEXT,
	status TEXT NOT NULL CHECK (status IN ('completed', 'refunded', 'revoked', 'voided')),
	purchased_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	invalidated_at TIMESTAMPTZ,
	invalidation_reason TEXT,
	reversed_amount BIGINT NOT NULL DEFAULT 0,
	reversed_credit_amount INTEGER NOT NULL DEFAULT 0,
	raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT purchases_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT purchases_project_customer_fk FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT purchases_project_product_fk FOREIGN KEY (project_id, product_id) REFERENCES products(project_id, id),
	CONSTRAINT purchases_project_store_product_fk FOREIGN KEY (project_id, store_product_id) REFERENCES store_products(project_id, id) ON DELETE SET NULL,
	CONSTRAINT purchases_project_subscription_fk FOREIGN KEY (project_id, subscription_id) REFERENCES subscriptions(project_id, id) ON DELETE SET NULL,
	CONSTRAINT purchases_reversed_amount_check CHECK (reversed_amount >= 0),
	CONSTRAINT purchases_reversed_credit_amount_check CHECK (reversed_credit_amount >= 0)
);

CREATE TABLE IF NOT EXISTS entitlements (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	entitlement_key TEXT NOT NULL,
	active BOOLEAN NOT NULL DEFAULT false,
	expires_at TIMESTAMPTZ,
	source_subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
	source_purchase_id UUID REFERENCES purchases(id) ON DELETE SET NULL,
	metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
	computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT entitlements_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT entitlements_project_customer_fk FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT entitlements_project_subscription_fk FOREIGN KEY (project_id, source_subscription_id) REFERENCES subscriptions(project_id, id) ON DELETE SET NULL,
	CONSTRAINT entitlements_project_purchase_fk FOREIGN KEY (project_id, source_purchase_id) REFERENCES purchases(project_id, id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS store_events (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	channel TEXT NOT NULL CHECK (channel IN ('ios', 'android', 'web')),
	external_event_id TEXT,
	event_fingerprint TEXT,
	event_type TEXT NOT NULL,
	customer_id UUID REFERENCES customers(id) ON DELETE SET NULL,
	store_product_id UUID REFERENCES store_products(id) ON DELETE SET NULL,
	transaction_id TEXT,
	purchase_kind TEXT CHECK (purchase_kind IS NULL OR purchase_kind IN ('subscription', 'consumable', 'non_consumable')),
	processing_status TEXT NOT NULL DEFAULT 'pending',
	processing_error TEXT,
	attempts INTEGER NOT NULL DEFAULT 0,
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	raw_payload JSONB NOT NULL,
	processed_at TIMESTAMPTZ,
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT store_events_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT store_events_project_customer_fk FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE SET NULL,
	CONSTRAINT store_events_project_store_product_fk FOREIGN KEY (project_id, store_product_id) REFERENCES store_products(project_id, id) ON DELETE SET NULL,
	CONSTRAINT store_events_processing_status_check CHECK (
		processing_status IN ('pending', 'processing', 'processed', 'skipped', 'failed')
	)
);

CREATE TABLE IF NOT EXISTS projection_sync_jobs (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	idempotency_key TEXT NOT NULL,
	reason TEXT NOT NULL,
	payload JSONB NOT NULL,
	status TEXT NOT NULL CHECK (status IN ('pending', 'processing', 'succeeded', 'failed')) DEFAULT 'pending',
	attempts INTEGER NOT NULL DEFAULT 0,
	last_error TEXT,
	reprojection_requested BOOLEAN NOT NULL DEFAULT false,
	next_attempt_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	locked_at TIMESTAMPTZ,
	locked_by TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT projection_sync_jobs_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT projection_sync_jobs_project_customer_fk FOREIGN KEY (project_id, customer_id) REFERENCES customers(project_id, id) ON DELETE CASCADE,
	CONSTRAINT projection_sync_jobs_reason_check CHECK (
		reason IN ('purchase_verified', 'provider_webhook', 'expiry_reconciliation', 'provider_reconciliation', 'usage_changed')
	),
	CONSTRAINT projection_sync_jobs_payload_check CHECK (
		COALESCE(jsonb_typeof(payload) = 'object', false)
		AND COALESCE(jsonb_typeof(payload->'billingAccountId') = 'string', false)
		AND COALESCE(jsonb_typeof(payload->'generatedAt') = 'string', false)
		AND COALESCE(jsonb_typeof(payload->'reason') = 'string', false)
		AND COALESCE(payload->>'reason' = reason, false)
		AND COALESCE(payload->>'generatedAt' = payload->'entitlements'->>'generatedAt', false)
		AND COALESCE(payload->>'billingAccountId' = payload->'entitlements'->>'billingAccountId', false)
		AND COALESCE(jsonb_typeof(payload->'entitlements') = 'object', false)
		AND COALESCE(jsonb_typeof(payload->'entitlements'->'entitlements') = 'array', false)
		AND COALESCE(jsonb_typeof(payload->'balances') = 'array', false)
		AND NOT (payload ? 'operation')
		AND NOT (payload ? 'purchase' AND payload ? 'reversal')
	)
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_customers_billing_account_id
	ON customers (project_id, billing_account_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_products_key
	ON products (project_id, key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_store_products_price
	ON store_products (project_id, provider, external_product_id, external_price_id)
	WHERE external_price_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_store_products_no_price
	ON store_products (project_id, provider, external_product_id)
	WHERE external_price_id IS NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_provider_customers_external
	ON provider_customers (project_id, provider, external_customer_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_provider_customers_stripe_customer
	ON provider_customers (project_id, customer_id, provider)
	WHERE provider = 'stripe';

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_subscriptions_external
	ON subscriptions (project_id, provider, external_subscription_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_purchases_transaction
	ON purchases (project_id, provider, transaction_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_entitlements_customer_key
	ON entitlements (project_id, customer_id, entitlement_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_store_events_external_event
	ON store_events (project_id, provider, external_event_id)
	WHERE external_event_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_store_events_null_event_fingerprint
	ON store_events (project_id, provider, event_fingerprint)
	WHERE external_event_id IS NULL
		AND event_fingerprint IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_projection_sync_jobs_idempotency
	ON projection_sync_jobs (project_id, idempotency_key);

CREATE INDEX IF NOT EXISTS idx_billing_projection_sync_jobs_due
	ON projection_sync_jobs (next_attempt_at, created_at)
	WHERE status = 'pending';

CREATE INDEX IF NOT EXISTS idx_billing_projection_sync_jobs_stale
	ON projection_sync_jobs (locked_at, created_at)
	WHERE status = 'processing';

CREATE INDEX IF NOT EXISTS idx_billing_store_events_due
	ON store_events (next_attempt_at, created_at)
	WHERE processing_status IN ('pending', 'skipped', 'failed');

CREATE INDEX IF NOT EXISTS idx_billing_store_events_stale_processing
	ON store_events (locked_at, created_at)
	WHERE processing_status = 'processing';

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_provider_reconciliation_due
	ON subscriptions (provider_reconciliation_next_attempt_at, provider_reconciled_at, expires_at)
	WHERE status IN ('active', 'grace_period', 'billing_retry', 'cancelled');

CREATE INDEX IF NOT EXISTS idx_billing_store_products_product_id
	ON store_products (product_id);

CREATE INDEX IF NOT EXISTS idx_billing_provider_customers_customer_id
	ON provider_customers (customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_store_events_customer_id
	ON store_events (customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_store_events_store_product_id
	ON store_events (store_product_id);

CREATE INDEX IF NOT EXISTS idx_billing_projection_sync_jobs_customer_id
	ON projection_sync_jobs (customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer_status
	ON subscriptions (customer_id, status);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_customer_expires
	ON subscriptions (customer_id, expires_at);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_product_id
	ON subscriptions (product_id);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_store_product_id
	ON subscriptions (store_product_id);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_latest_transaction
	ON subscriptions (latest_transaction_id);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_customer_created
	ON purchases (customer_id, created_at);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_product_id
	ON purchases (product_id);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_store_product_id
	ON purchases (store_product_id);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_subscription_id
	ON purchases (subscription_id);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_original_transaction
	ON purchases (original_transaction_id);

CREATE INDEX IF NOT EXISTS idx_billing_entitlements_source_subscription_id
	ON entitlements (source_subscription_id);

CREATE INDEX IF NOT EXISTS idx_billing_entitlements_source_purchase_id
	ON entitlements (source_purchase_id);

CREATE INDEX IF NOT EXISTS idx_billing_entitlements_key_customer
	ON entitlements (entitlement_key, customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_provider_customers_external_customer_id
	ON provider_customers (external_customer_id);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_raw_payload_order_id
	ON purchases ((raw_payload->>'orderId'))
	WHERE raw_payload ? 'orderId';

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_raw_state_order_id
	ON subscriptions ((raw_state->>'orderId'))
	WHERE raw_state ? 'orderId';

CREATE INDEX IF NOT EXISTS idx_billing_customers_billing_account_id_trgm
	ON customers USING gin (billing_account_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_provider_customers_external_customer_id_trgm
	ON provider_customers USING gin (external_customer_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_transaction_id_trgm
	ON purchases USING gin (transaction_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_purchases_original_transaction_id_trgm
	ON purchases USING gin (original_transaction_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_external_subscription_id_trgm
	ON subscriptions USING gin (external_subscription_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_latest_transaction_id_trgm
	ON subscriptions USING gin (latest_transaction_id gin_trgm_ops);

CREATE INDEX IF NOT EXISTS idx_billing_entitlements_entitlement_key_trgm
	ON entitlements USING gin (entitlement_key gin_trgm_ops);

CREATE TABLE IF NOT EXISTS checkout_requests (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	store_product_id UUID REFERENCES store_products(id) ON DELETE RESTRICT,
	provider TEXT NOT NULL CHECK (provider = 'stripe'),
	idempotency_key TEXT NOT NULL CHECK (
		char_length(idempotency_key) BETWEEN 1 AND 200
	),
	request_hash TEXT NOT NULL CHECK (char_length(request_hash) = 64),
	status TEXT NOT NULL DEFAULT 'creating' CHECK (status IN ('creating', 'created')),
	external_session_id TEXT,
	session_url TEXT,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	plan_version_id BIGINT,
	requested_quantities JSONB NOT NULL DEFAULT '{}'::jsonb,
	requested_addon_plan_version_ids BIGINT[] NOT NULL DEFAULT '{}',
	CONSTRAINT checkout_requests_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT checkout_requests_project_customer_fk
		FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT checkout_requests_project_store_product_fk
		FOREIGN KEY (project_id, store_product_id)
		REFERENCES store_products(project_id, id),
	CONSTRAINT checkout_requests_target_check CHECK (
		(store_product_id IS NOT NULL AND plan_version_id IS NULL)
		OR (store_product_id IS NULL AND plan_version_id IS NOT NULL)
	),
	CONSTRAINT checkout_requests_quantities_check CHECK (
		jsonb_typeof(requested_quantities) = 'object'
	)
);

CREATE TABLE IF NOT EXISTS credit_grants (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
	grant_key TEXT NOT NULL,
	grant_kind TEXT NOT NULL CHECK (grant_kind IN ('monthly', 'upgrade', 'topup')),
	credits INTEGER NOT NULL CHECK (credits > 0),
	expires_at TIMESTAMPTZ,
	plan TEXT,
	source_event_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT credit_grants_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT credit_grants_project_customer_fk
		FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT credit_grants_project_subscription_fk
		FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id)
		ON DELETE NO ACTION,
	CONSTRAINT credit_grants_expiry_check CHECK (
		(grant_kind = 'topup' AND expires_at IS NULL AND subscription_id IS NULL)
		OR (grant_kind IN ('monthly', 'upgrade') AND expires_at IS NOT NULL)
	)
);

CREATE TABLE IF NOT EXISTS credit_grant_provider_objects (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	grant_id UUID NOT NULL REFERENCES credit_grants(id) ON DELETE CASCADE,
	provider TEXT NOT NULL CHECK (provider IN ('apple', 'google', 'stripe')),
	provider_object_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT credit_grant_provider_objects_project_grant_fk
		FOREIGN KEY (project_id, grant_id)
		REFERENCES credit_grants(project_id, id)
		ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS credit_reversals (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	grant_id UUID NOT NULL REFERENCES credit_grants(id) ON DELETE RESTRICT,
	reversal_key TEXT NOT NULL,
	reason TEXT NOT NULL CHECK (reason IN ('refund', 'dispute', 'void')),
	expected_credits INTEGER NOT NULL CHECK (expected_credits > 0),
	source_event_id TEXT NOT NULL,
	provider_object_id TEXT NOT NULL,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT credit_reversals_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT credit_reversals_project_customer_fk
		FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT credit_reversals_project_grant_fk
		FOREIGN KEY (project_id, grant_id)
		REFERENCES credit_grants(project_id, id)
		ON DELETE RESTRICT
);

CREATE TABLE IF NOT EXISTS billing_invoices (
	id UUID PRIMARY KEY DEFAULT uuid_generate_v4(),
	project_id UUID NOT NULL REFERENCES projects(id) ON DELETE RESTRICT,
	customer_id UUID NOT NULL REFERENCES customers(id) ON DELETE CASCADE,
	subscription_id UUID REFERENCES subscriptions(id) ON DELETE SET NULL,
	external_invoice_id TEXT NOT NULL,
	external_subscription_id TEXT,
	status TEXT NOT NULL,
	amount_paid BIGINT NOT NULL DEFAULT 0 CHECK (amount_paid >= 0),
	currency TEXT NOT NULL,
	paid_at TIMESTAMPTZ,
	provider_created_at TIMESTAMPTZ NOT NULL,
	last_provider_event_created BIGINT NOT NULL DEFAULT 0,
	raw_payload JSONB NOT NULL DEFAULT '{}'::jsonb,
	created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
	CONSTRAINT billing_invoices_project_id_id_unique UNIQUE (project_id, id),
	CONSTRAINT billing_invoices_project_customer_fk
		FOREIGN KEY (project_id, customer_id)
		REFERENCES customers(project_id, id)
		ON DELETE CASCADE,
	CONSTRAINT billing_invoices_project_subscription_fk
		FOREIGN KEY (project_id, subscription_id)
		REFERENCES subscriptions(project_id, id)
		ON DELETE NO ACTION
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_checkout_requests_idempotency
	ON checkout_requests (project_id, customer_id, idempotency_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_checkout_requests_session
	ON checkout_requests (project_id, provider, external_session_id)
	WHERE external_session_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_checkout_requests_customer_created
	ON checkout_requests (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_checkout_requests_store_product_id
	ON checkout_requests (store_product_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_credit_grants_key
	ON credit_grants (project_id, grant_key);

CREATE INDEX IF NOT EXISTS idx_billing_credit_grants_customer_created
	ON credit_grants (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_credit_grants_subscription_id
	ON credit_grants (subscription_id)
	WHERE subscription_id IS NOT NULL;

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_credit_grant_provider_object
	ON credit_grant_provider_objects (project_id, provider, provider_object_id);

CREATE INDEX IF NOT EXISTS idx_billing_credit_grant_provider_objects_grant_id
	ON credit_grant_provider_objects (grant_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_credit_reversals_key
	ON credit_reversals (project_id, reversal_key);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_credit_reversals_first_grant
	ON credit_reversals (project_id, grant_id);

CREATE INDEX IF NOT EXISTS idx_billing_credit_reversals_customer_created
	ON credit_reversals (customer_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_credit_reversals_grant_id
	ON credit_reversals (grant_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_invoices_external
	ON billing_invoices (project_id, external_invoice_id);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_customer_created
	ON billing_invoices (customer_id, provider_created_at DESC);

CREATE INDEX IF NOT EXISTS idx_billing_invoices_subscription_id
	ON billing_invoices (subscription_id)
	WHERE subscription_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_last_provider_event
	ON subscriptions (project_id, provider, last_provider_event_created);

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_plan_version
	ON subscriptions (plan_version_id)
	WHERE plan_version_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_billing_subscriptions_entity
	ON subscriptions (project_id, entity_id, status)
	WHERE entity_id IS NOT NULL;
