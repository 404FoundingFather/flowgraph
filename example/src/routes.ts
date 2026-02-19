import { CreateTaskSchema } from "./types.js";
import { TaskRepository } from "./repository.js";

export function registerRoutes(app: any, repo: TaskRepository) {
  app.post("/tasks", async (req: any, res: any) => {
    const input = CreateTaskSchema.parse(req.body);
    const task = await repo.create(input);
    res.status(201).json(task);
  });

  app.get("/tasks", async (_req: any, res: any) => {
    const tasks = await repo.list();
    res.json(tasks);
  });

  app.get("/tasks/:id", async (req: any, res: any) => {
    const task = await repo.findById(Number(req.params.id));
    if (!task) return res.status(404).json({ error: "Not found" });
    res.json(task);
  });

  app.patch("/tasks/:id/status", async (req: any, res: any) => {
    const task = await repo.updateStatus(Number(req.params.id), req.body.status);
    if (!task) return res.status(404).json({ error: "Not found" });
    res.json(task);
  });
}
