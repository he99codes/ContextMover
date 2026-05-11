export default function MigrateLoading() {
  return (
    <div className="p-8 animate-pulse">
      <div className="mb-6 h-7 w-40 rounded-[4px] bg-[#1A1A1A]" />
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <div className="space-y-3">
          <div className="h-4 w-24 rounded-[4px] bg-[#1A1A1A]" />
          <div className="h-10 rounded-[4px] bg-[#111111] border border-[#1A1A1A]" />
          <div className="space-y-2">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="h-16 rounded-[8px] bg-[#111111] border border-[#1A1A1A]" />
            ))}
          </div>
        </div>
        <div className="space-y-3">
          <div className="h-4 w-32 rounded-[4px] bg-[#1A1A1A]" />
          <div className="grid grid-cols-3 gap-2">
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} className="h-12 rounded-[8px] bg-[#111111] border border-[#1A1A1A]" />
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
