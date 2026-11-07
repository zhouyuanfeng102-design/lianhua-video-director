import type { Project, ReferenceAsset, SourceDocument, ViewKey } from "../../types";

export type PhoneHomeAction = {
  view: ViewKey;
  label: "导入剧情" | "解析剧情" | "去写提示词" | "去生成视频";
};

export function phoneStoryCount(project: Pick<Project, "sourceDocuments" | "scenes">): { count: number; note: string } {
  const chapters = project.sourceDocuments.filter((document: SourceDocument) => !document.archived && document.content.trim());
  if (chapters.length > 0) return { count: chapters.length, note: "章节正文" };
  return { count: project.scenes.length, note: "场景" };
}

export function phoneHomeAction(input: {
  storyCount: number;
  sceneCount: number;
  promptCount: number;
}): PhoneHomeAction {
  if (input.storyCount <= 0) return { view: "story", label: "导入剧情" };
  if (input.sceneCount <= 0) return { view: "story", label: "解析剧情" };
  if (input.promptCount <= 0) return { view: "director", label: "去写提示词" };
  return { view: "video", label: "去生成视频" };
}

export function phoneCreationNext(view: ViewKey): { view: ViewKey; label: string } | undefined {
  if (view === "story") return { view: "director", label: "去写提示词" };
  if (view === "director") return { view: "storyboard", label: "去看分镜" };
  if (view === "storyboard") return { view: "video", label: "去生成视频" };
  return undefined;
}

export function phoneVideoCount(assets: readonly Pick<ReferenceAsset, "mediaType">[]): number {
  return assets.filter((asset) => asset.mediaType === "video").length;
}
