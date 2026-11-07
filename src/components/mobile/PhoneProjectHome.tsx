import type { Scene } from "../../types";
import { phoneHomeAction, phoneStoryCount, phoneVideoCount, type PhoneHomeAction } from "./phoneFlow";

export function PhoneProjectHome({ projectName, project, onOpenProjects, onNewProject, onOpen, onScene }: {
  projectName: string;
  project: { sourceDocuments: Parameters<typeof phoneStoryCount>[0]["sourceDocuments"]; scenes: Scene[]; storyboards: { shots: unknown[] }[]; assets: Parameters<typeof phoneVideoCount>[0] };
  onOpenProjects: () => void;
  onNewProject: () => void;
  onOpen: (action: PhoneHomeAction) => void;
  onScene: (sceneId: string) => void;
}) {
  const story = phoneStoryCount(project);
  const promptCount = project.storyboards.length;
  const shotCount = project.storyboards.reduce((total, board) => total + board.shots.length, 0);
  const videoCount = phoneVideoCount(project.assets);
  const action = phoneHomeAction({ storyCount: story.count, sceneCount: project.scenes.length, promptCount });
  const cells: { label: string; value: number; note: string; target: PhoneHomeAction["view"]; home?: PhoneHomeAction }[] = [
    { label: "剧情", value: story.count, note: story.note, target: "story" },
    { label: "提示词", value: promptCount, note: "已保存稿", target: "director" },
    { label: "分镜", value: shotCount, note: "镜头", target: "storyboard" },
    { label: "视频", value: videoCount, note: "成片", target: "video" },
  ];
  return (
    <div className="phone-project-home">
      <button type="button" className="phone-project-title" onClick={onOpenProjects}>{projectName}</button>
      <div className="phone-count-grid">
        {cells.map((cell) => (
          <button key={cell.label} type="button" className="phone-count" onClick={() => onOpen(cell.target === "video" ? { view: "video", label: "去生成视频" } : { view: cell.target, label: action.label })}>
            <span>{cell.label}</span>
            <strong>{cell.value}</strong>
            <small>{cell.note}</small>
          </button>
        ))}
      </div>
      <button type="button" className="phone-primary" onClick={() => onOpen(action)}>{action.label}</button>
      <div className="phone-secondary-row">
        <button type="button" onClick={onNewProject}>新建项目</button>
        <button type="button" onClick={onOpenProjects}>项目库</button>
      </div>
      <section className="phone-recent">
        <h2>最近场景</h2>
        {project.scenes.length ? project.scenes.slice(0, 2).map((scene) => (
          <button key={scene.id} type="button" className="phone-scene" onClick={() => onScene(scene.id)}>
            <strong>{scene.title}</strong>
            <span>{scene.summary || scene.content.slice(0, 64)}</span>
          </button>
        )) : <p>还没有场景。粘贴原文后，用解析把场景拆出来。</p>}
      </section>
    </div>
  );
}

