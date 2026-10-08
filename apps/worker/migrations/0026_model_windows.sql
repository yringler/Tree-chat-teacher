CREATE TABLE `model_windows` (
	`model` text PRIMARY KEY NOT NULL,
	`context_tokens` integer NOT NULL,
	`max_output_tokens` integer,
	`updated_at` text NOT NULL
);
