import { notFound } from "next/navigation";
import { getTask } from "@/lib/tasks";
import { Mission } from "./mission";

export const dynamic = "force-dynamic";

export default async function TaskPage({ params }: PageProps<"/tasks/[id]">) {
  const { id } = await params;
  const task = await getTask(decodeURIComponent(id));
  if (!task) notFound();
  return <Mission initial={task} />;
}
