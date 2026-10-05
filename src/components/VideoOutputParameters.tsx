import type { VideoGenerationSource } from '../videoGenerationTypes';
import type { RunningHubVideoFieldControl } from '../runningHubVideoTypes';
import { readVideoParameterText, videoParameterInputText, type VideoOutputParameterKey } from '../videoOutputParameters';
import '../videoOutputParameters.css';

export interface VideoOutputParametersProps {
  scope: 'single' | 'batch';
  source: VideoGenerationSource;
  parameterText: string;
  availableKeys: readonly string[];
  controls?: Record<string, RunningHubVideoFieldControl>;
  defaultValues?: Record<string, unknown>;
  requiresMapping?: boolean;
  disabled?: boolean;
  onChange: (key: VideoOutputParameterKey, value: string) => void;
  onOpenSettings?: () => void;
}

/** Explicit task overrides only; this component never writes defaults during rendering. */
export function VideoOutputParameters({ scope, source, parameterText, availableKeys, controls = {}, defaultValues = {}, requiresMapping = source !== 'api', disabled = false, onChange, onOpenSettings }: VideoOutputParametersProps) {
  const parsed = readVideoParameterText(parameterText);
  const available = new Set(availableKeys);
  const prefix = scope === 'batch' ? '批量' : '本次';
  const hasValue = (key: VideoOutputParameterKey) => Object.prototype.hasOwnProperty.call(parsed.value, key) && parsed.value[key] !== undefined;
  const supported = (key: VideoOutputParameterKey) => available.has(key) || !requiresMapping && hasValue(key);
  const pixelKeys = (['width', 'height'] as const).filter((key) => controls[key]?.unit === 'MP' && (available.has(key) || hasValue(key)));
  const dimensions = (['width', 'height'] as const).some((key) => controls[key]?.unit !== 'MP' && (available.has(key) || hasValue(key)));
  const showAspectRatio = available.has('aspect_ratio') || hasValue('aspect_ratio');
  const showResolution = available.has('resolution') || hasValue('resolution') || !dimensions && !pixelKeys.length;
  const missing = [!available.has('duration') ? '视频时长' : '', !available.has('resolution') && !available.has('width') && !available.has('height') ? '分辨率' : ''].filter(Boolean);
  const field = (key: VideoOutputParameterKey, label: string, ariaLabel: string) => {
    const control = controls[key];
    const unit = control?.unit === 'MP' ? ' MP' : '';
    const value = videoParameterInputText(parsed.value[key]);
    const defaultValue = videoParameterInputText(defaultValues[key]);
    const locked = disabled || Boolean(parsed.issue) || !supported(key);
    const options = [...new Set(control?.options || [])].filter((option) => option !== '');
    const fixedMpChoices = control?.kind === 'select' && control.unit === 'MP' && options.length > 0;
    const selectedOption = options.find((option) => option === value || fixedMpChoices && value.trim() !== '' && Number(option) === Number(value));
    const optionLabel = (option: string) => `${option}${unit}${control?.optionLabels?.[option] ? `（${control.optionLabels[option]}）` : ''}`;
    const defaultOption = options.find((option) => option === defaultValue || fixedMpChoices && defaultValue.trim() !== '' && Number(option) === Number(defaultValue));
    const defaultLabel = defaultValue ? `使用默认值（${optionLabel(defaultOption ?? defaultValue)}）` : '使用默认值';
    return <div className="field vop-field" key={key}>
    <div className="vop-field-label"><span>{unit ? '像素（MP）' : label}</span>{hasValue(key) && <button type="button" className="vop-clear" aria-label={`清除${prefix}${ariaLabel}覆盖`} disabled={disabled || Boolean(parsed.issue)} onClick={() => onChange(key, '')}>清除该覆盖</button>}</div>
    <div className="vop-value-editor">
      {options.length > 0 && <select aria-label={`${prefix}${ariaLabel}选项`} disabled={locked}
        value={!hasValue(key) ? '__default__' : selectedOption !== undefined ? `value:${selectedOption}` : '__custom__'}
        onChange={(event) => {
          if (event.target.value === '__default__') onChange(key, '');
          else if (event.target.value.startsWith('value:') && options.includes(event.target.value.slice(6))) onChange(key, event.target.value.slice(6));
        }}>
        <option value="__default__">{defaultLabel}</option>
        {options.map((option) => <option key={option} value={`value:${option}`}>{optionLabel(option)}</option>)}
        <option value="__custom__" disabled>{fixedMpChoices ? `已保存原值：${value}${unit}` : '自定义值（在下方输入）'}</option>
      </select>}
      {!fixedMpChoices && <input aria-label={`${prefix}${ariaLabel}`} type="text" inputMode={control?.kind === 'number' || key !== 'resolution' ? 'decimal' : 'text'}
        value={value} disabled={locked}
        placeholder={supported(key) ? defaultValue ? defaultLabel : '保留原值' : requiresMapping ? source === 'api' ? '模板未配置此参数' : '请先绑定节点' : '使用高级 JSON'}
        onChange={(event) => onChange(key, event.target.value)} />}
      {(unit || control?.min !== undefined || control?.max !== undefined || options.length > 0) && <small className="vop-control-hint">
        {unit ? fixedMpChoices ? 'MP 为百万像素；按工作流档位选择。' : 'MP 为百万像素；可直接输入小数。' : '可选择选项或直接输入。'}
        {(control?.min !== undefined || control?.max !== undefined) && ` 范围 ${control.min ?? '不限'}–${control.max ?? '不限'}${unit}。`}
        {control?.step !== undefined && ` 步长 ${control.step}。`}
        {control?.optionLabels && control.optionLabelAspectRatio && ` 尺寸按 ${control.optionLabelAspectRatio}，二采后以成片为准。`}
      </small>}
    </div>
    {requiresMapping && hasValue(key) && !available.has(key) && <small className="vop-stale">{source === 'api' ? '接口模板未提供此参数，请清除或修改模板' : '当前工作流未绑定，请清除或重新绑定'}</small>}
  </div>;
  };
  const notes = <>
    {scope === 'batch' && <p className="vop-help">每段统一覆盖时长，不是全片总时长；留空保持原参数。</p>}
    <details className="vop-help vop-help-details"><summary>参数填写说明</summary><p>时长单位为秒，不自动换算帧数；画面比例按工作流提供的完整选项值提交；分辨率按接口原格式填写，不自动计算宽高。</p></details>
    {requiresMapping && missing.length > 0 && <div className="vop-unavailable"><span>{source === 'api' ? '接口模板尚未提供' : '尚未绑定'}{missing.join('、')}。</span>{onOpenSettings && <button className="btn small" type="button" disabled={disabled} onClick={onOpenSettings}>配置时长、比例与分辨率</button>}</div>}
  </>;
  return <section className={`video-output-parameters${scope === 'batch' ? ' vop-batch' : ''}`} aria-label={`${prefix}时长、比例与分辨率`}>
    <div className="vop-heading"><strong>{scope === 'batch' ? '批量视频时长、比例与分辨率' : '视频时长、比例与分辨率'}</strong><span>留空保持原值</span></div>
    <div className="vop-fields" data-count={1 + Number(showAspectRatio) + Number(showResolution) + pixelKeys.length}>
      {field('duration', '视频时长（秒）', '视频时长（秒）')}
      {showAspectRatio && field('aspect_ratio', '画面比例', '视频画面比例')}
      {showResolution && field('resolution', '分辨率', '视频分辨率')}
      {pixelKeys.map((key) => field(key, '像素', key === 'width' ? '视频宽度（像素）' : '视频高度（像素）'))}
    </div>
    {dimensions && <details className="vop-dimensions"><summary>高级：指定宽高</summary><div className="vop-fields">
      {controls.width?.unit !== 'MP' && field('width', '宽度（像素）', '视频宽度（像素）')}
      {controls.height?.unit !== 'MP' && field('height', '高度（像素）', '视频高度（像素）')}
    </div></details>}
    {scope === 'batch' ? <div className="vop-batch-notes">{notes}</div> : notes}
    {parsed.issue && <p className="vd-error vop-error" role="alert">{parsed.issue}</p>}
  </section>;
}
