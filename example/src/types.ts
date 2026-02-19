import { z } from "zod";

// ─── Task Status ─────────────────────────────────────────────────────────────

export type TaskStatus = "pending" | "in_progress" | "done" | "cancelled";

// ─── Schemas ─────────────────────────────────────────────────────────────────

export const CreateTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  assignee: z.string().optional(),
});

export type CreateTask = z.infer<typeof CreateTaskSchema>;

export interface Task {
  id: number;
  title: string;
  description: string | null;
  assignee: string | null;
  status: TaskStatus;
  created_at: string;
}
