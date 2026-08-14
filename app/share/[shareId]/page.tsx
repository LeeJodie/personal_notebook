import SharedReader from "./shared-reader";

export default async function SharePage({ params }: { params: Promise<{ shareId: string }> }) {
  const { shareId } = await params;
  return <SharedReader shareId={shareId} />;
}
