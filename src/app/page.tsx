import BrandSearch from "@/app/components/BrandSearch";
import { fetchBrandsFromDatabase } from "@/app/lib/search-config";

export const dynamic = "force-dynamic";

export default async function Home() {
  const items = await fetchBrandsFromDatabase();

  return (
    <div className="min-h-screen bg-black text-zinc-100">
      <main className="mx-auto flex min-h-screen max-w-5xl flex-col items-center justify-center px-6 py-24">
        <div className="mb-16 flex flex-col items-center gap-5 text-center">
          <p className="font-mono text-[11px] uppercase tracking-[0.35em] text-zinc-600">
            Step 01 · Index Platform
          </p>
          <h1 className="max-w-2xl text-4xl font-semibold tracking-tight text-zinc-50 sm:text-5xl">
            Turbo Fashion Index
          </h1>
          <p className="max-w-lg text-sm leading-7 text-zinc-500">
            Search the index and jump straight to a detail page.
          </p>
        </div>

        <div className="w-full max-w-xl">
          <BrandSearch items={items} />
        </div>

        <footer className="mt-20 font-mono text-[10px] uppercase tracking-[0.28em] text-zinc-700">
          Architecture Platform · v0.1
        </footer>
      </main>
    </div>
  );
}
