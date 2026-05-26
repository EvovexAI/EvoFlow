import { notFound } from "next/navigation";

/** 旧路径 /resume 已废弃，请使用私密直链 /r/{slug} */
export default function Page() {
  notFound();
}
