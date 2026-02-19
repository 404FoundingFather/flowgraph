import type { CreateTask, Task, TaskStatus } from "./types.js";

export class TaskRepository {
  private db: any;

  constructor(db: any) {
    this.db = db;
  }

  async create(input: CreateTask): Promise<Task> {
    const result = await this.db.query(
      `INSERT INTO tasks (title, description, assignee, status)
       VALUES ($1, $2, $3, 'pending') RETURNING *`,
      [input.title, input.description ?? null, input.assignee ?? null]
    );
    return result.rows[0];
  }

  async updateStatus(id: number, status: TaskStatus): Promise<Task | null> {
    const result = await this.db.query(
      `UPDATE tasks SET status = $1 WHERE id = $2 RETURNING *`,
      [status, id]
    );
    return result.rows[0] ?? null;
  }

  async findById(id: number): Promise<Task | null> {
    const result = await this.db.query(
      `SELECT * FROM tasks WHERE id = $1`,
      [id]
    );
    return result.rows[0] ?? null;
  }

  async list(): Promise<Task[]> {
    const result = await this.db.query(
      `SELECT * FROM tasks ORDER BY created_at DESC`
    );
    return result.rows;
  }
}
