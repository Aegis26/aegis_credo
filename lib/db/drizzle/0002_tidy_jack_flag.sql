ALTER TABLE "machine_credentials" ALTER COLUMN "scopes" SET DATA TYPE jsonb USING to_jsonb("scopes");--> statement-breakpoint
ALTER TABLE "machine_audit" ADD COLUMN "actor_user_id" uuid;--> statement-breakpoint
ALTER TABLE "machine_credentials" ADD COLUMN "is_active" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "machine_audit" ADD CONSTRAINT "machine_audit_actor_user_id_users_id_fk" FOREIGN KEY ("actor_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;