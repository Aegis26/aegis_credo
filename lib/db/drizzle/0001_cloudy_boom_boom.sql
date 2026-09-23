CREATE TABLE "machine_audit" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid,
	"credential_id" uuid,
	"action" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"status" text NOT NULL,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "machine_credentials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"org_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scopes" text[] NOT NULL,
	"notes" text,
	"key_hash" text NOT NULL,
	"created_by" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone,
	"revoked_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "machine_audit" ADD CONSTRAINT "machine_audit_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_audit" ADD CONSTRAINT "machine_audit_credential_id_machine_credentials_id_fk" FOREIGN KEY ("credential_id") REFERENCES "public"."machine_credentials"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_org_id_organizations_id_fk" FOREIGN KEY ("org_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD CONSTRAINT "machine_credentials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "machine_credentials_key_hash_unique" ON "machine_credentials" USING btree ("key_hash");--> statement-breakpoint
CREATE INDEX "machine_credentials_org_idx" ON "machine_credentials" USING btree ("org_id");--> statement-breakpoint
CREATE INDEX "machine_credentials_active_idx" ON "machine_credentials" USING btree ("org_id","revoked_at");