-- Refunds, disputes, their reinstatements and a membership payment's revenue share taken
-- back name the payment they take back from (`payment_ref`), so together they never take
-- back more than it granted (docs/polar-migration/06-payment-audit.md, R6). Rows from
-- before this migration have none.
ALTER TABLE `credit_grants` ADD `payment_ref` text;--> statement-breakpoint
CREATE INDEX `credit_grants_payment_idx` ON `credit_grants` (`payment_ref`);