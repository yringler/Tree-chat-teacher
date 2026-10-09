ALTER TABLE `nodes` ADD `error_kind` text;--> statement-breakpoint
-- One-time backfill: rows written before the column carry only the copy, so their kind is read from it.
UPDATE `nodes` SET `error_kind` = 'cut_off' WHERE `status` = 'error' AND `error` = 'The reply reached its length limit before it finished, so it was cut off.';--> statement-breakpoint
UPDATE `nodes` SET `error_kind` = 'thinking_only' WHERE `status` = 'error' AND `error` = 'The model used its whole length limit thinking and wrote no answer. Try again, or ask a narrower question.';--> statement-breakpoint
UPDATE `nodes` SET `error_kind` = 'empty' WHERE `status` = 'error' AND `error` = 'The model finished without writing an answer. Try again.';--> statement-breakpoint
UPDATE `nodes` SET `error_kind` = 'cancelled' WHERE `status` = 'error' AND `error` = 'Cancelled';--> statement-breakpoint
UPDATE `nodes` SET `error_kind` = 'interrupted' WHERE `status` = 'error' AND `error` = 'Interrupted before the reply finished';--> statement-breakpoint
UPDATE `nodes` SET `error_kind` = 'provider' WHERE `status` = 'error' AND `error` = 'The provider stream ended unexpectedly';
