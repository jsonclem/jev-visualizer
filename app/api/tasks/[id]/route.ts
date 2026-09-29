import { getTask } from "@/lib/tasks";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: RouteContext<"/api/tasks/[id]">) {
  const { id } = await params;
  const task = await getTask(decodeURIComponent(id));
  if (!task) return Response.json({ error: "not found" }, { status: 404 });
  return Response.json(task, { headers: { "Cache-Control": "no-store" } });
}
