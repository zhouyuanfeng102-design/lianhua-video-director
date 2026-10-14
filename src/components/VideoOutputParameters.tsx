import type { VideoGenerationSource } from '../videoGenerationTypes';
import { readVideoParameterText, videoParameterInputText, videoOutputParameterChoices, type VideoOutputParameterControl, type VideoOutputParameterKey } from '../videoOutputParameters';
import '../videoOutputParameters.css';

export interface VideoOutputParametersProps {
  scope: 'single' | 'batch';
  source: VideoGenerationSource;
  parameterText: string;
  availableKeys: readonly string[];
  controls?: Record<string, VideoOutputParameterControl>;
  defaultValues?: Record<string, unknown>;
  /** Only generic API parameters use upstream schemas; cloud workflow values stay intact. */
  upstreamParameters?: boolean;
  requiresMapping?: boolean;
  disabled?: boolean;
  onChange: (key: VideoOutputParameterKey, value: string) => void;
  onOpenSettings?: () => void;
}

/** Explicit task overrides only; this component never writes defaults during rendering. */
export function VideoOutputParameters({ scope, source, parameterText, availableKeys, controls = {}, defaultValues = {}, upstreamParameters: readUpstreamParameters = false, requiresMapping = source !== 'api', disabled = false, onChange, onOpenSettings }: VideoOutputParametersProps) {
  const parsed = readVideoParameterText(parameterText);
  const upstreamParameters = readUpstreamParameters && source === 'api' && !requiresMapping;
  const available = new Set(availableKeys);
  const prefix = scope === 'batch' ? '批量' : '本次';
  const hasValue = (key: VideoOutputParameterKey) => Object.prototype.hasOwnProperty.call(parsed.value, key) && parsed.value[key] !== undefined;
  const supported = (key: VideoOutputParameterKey) => available.has(key) || !requiresMapping && hasValue(key);
  const pixelKeys = (['width', 'height'] as const).filter((key) => controls[key]?.unit === 'MP' && (available.has(key) || hasValue(key)));
  const dimensions = (['width', 'height'] as const).some((key) => controls[key]?.unit !== 'MP' && (available.has(key) || hasValue(key)));
  const showAspectRatio = available.has('aspect_ratio') || hasValue('aspect_ratio');
  const showResolution = available.has('resolution') || hasValue('resolution') || !dimensions && !pixelKeys.length;
  const showSteps = requiresMapping || available.has('steps') || hasValue('steps');
  const missing = [!available.has('duration') ? '视频时长' : '', !available.has('resolution') && !available.has('width') && !available.has('height') ? '分辨率' : '', showSteps && !available.has('steps') ? '采样步数' : ''].filter(Boolean);
  const field = (key: VideoOutputParameterKey, label: string, ariaLabel: string) => {
    const control = controls[key];
    const unit = control?.unit === 'MP' ? ' MP' : '';
    const value = videoParameterInputText(parsed.value[key]);
    const defaultValue = videoParameterInputText(defaultValues[key]);
    const locked = disabled || Boolean(parsed.issue) || !supported(key);
    const choices = videoOutputParameterChoices(key, control, upstreamParameters);
    const { options } = choices;
    const fixedMpChoices = control?.kind === 'select' && control.unit === 'MP' && options.length > 0;
    const fixedUpstreamChoices = upstreamParameters && control?.restricted === true && options.length > 0;
    const fixedChoices = fixedMpChoices || fixedUpstreamChoices;
    const selectedOption = options.find((option) => option === value || fixedMpChoices && value.trim() !== '' && Number(option) === Number(value));
    const optionLabel = (option: string) => `${option}${unit}${control?.optionLabels?.[option] ? `（${control.optionLabels[option]}）` : ''}`;
    const defaultOption = options.find((option) => option === defaultValue || fixedMpChoices && defaultValue.trim() !== '' && Number(option) === Number(defaultValue));
    const defaultLabel = defaultValue ? `${upstreamParameters ? '保留原值；上游默认' : '使用默认值'}（${optionLabel(defaultOption ?? defaultValue)}）` : upstreamParameters ? '保留原值 / 接口默认' : '使用默认值';
    const compactDefaultValue = key === 'aspect_ratio' ? defaultValue.match(/\d+(?:\.\d+)?\s*[:：]\s*\d+(?:\.\d+)?/u)?.[0] || defaultValue : defaultValue;
    const displayedDefaultLabel = scope === 'batch' ? upstreamParameters ? defaultValue ? `保留原值（上游默认 ${compactDefaultValue}）` : '保留原值 / 接口默认'
      : defaultValue ? `默认：${compactDefaultValue}${unit}` : '默认' : defaultLabel;
    const workflowHint = (unit ? fixedMpChoices ? 'MP 为百万像素；按工作流档位选择。' : 'MP 为百万像素；可直接输入小数。' : '可选择选项或直接输入。')
      + ((control?.min !== undefined || control?.max !== undefined) ? ` 范围 ${control.min ?? '不限'}–${control.max ?? '不限'}${unit}。` : '')
      + (control?.step !== undefined ? ` 步长 ${control.step}。` : '')
      + (control?.optionLabels && control.optionLabelAspectRatio ? ` 尺寸按 ${control.optionLabelAspectRatio}，二采后以成片为准。` : '');
    const hasRange = control?.min !== undefined || control?.max !== undefined;
    const upstreamHint = (choices.common ? hasRange ? '范围内常用选项；也可自定义。' : control ? '上游未限定可选值；常用选项可选，也可自定义。' : '上游未提供参数限制。常用选项，上游支持情况未读取；也可自定义。'
      : options.length > 0 ? fixedUpstreamChoices ? '上游允许选项。' : '上游推荐选项；也可自定义。' : hasRange ? '' : '上游未提供参数限制。')
      + (hasRange ? ` 上游范围 ${control.min ?? '不限'}–${control.max ?? '不限'}${key === 'duration' ? ' 秒' : ''}。` : '')
      + (control?.step !== undefined ? ` 步长 ${control.step}。` : '')
      + (defaultValue ? ` 上游默认 ${defaultValue}${key === 'duration' ? ' 秒' : ''}；留空保持原值。` : '')
      + (control?.description ? ` ${control.description}` : '');
    const controlHint = upstreamParameters ? upstreamHint.trim() : workflowHint;
    const controlTitle = `${hasValue(key) ? value : defaultLabel} ${controlHint}`;
    const numericValue = value.trim() === '' ? undefined : Number(value);
    const numericControl = upstreamParameters && control?.kind === 'number';
    const numericInput = numericControl && (numericValue === undefined || Number.isFinite(numericValue));
    const invalidNumber = hasValue(key) && numericControl && !Number.isFinite(numericValue);
    const outsideRange = hasValue(key) && numericControl && numericValue !== undefined && Number.isFinite(numericValue)
      && (control?.min !== undefined && numericValue < control.min || control?.max !== undefined && numericValue > control.max);
    const invalidStep = hasValue(key) && numericControl && numericValue !== undefined && Number.isFinite(numericValue) && control?.step !== undefined && control.step > 0
      && Math.abs((numericValue - (control.min ?? 0)) / control.step - Math.round((numericValue - (control.min ?? 0)) / control.step)) > 1e-8;
    const constraintIssue = fixedUpstreamChoices && hasValue(key) && selectedOption === undefined ? '已保存值不在上游允许选项中；请选择支持的值或清除覆盖。'
      : invalidNumber ? '已保存值不是有效数字；请按上游范围修改或清除覆盖。'
      : outsideRange ? '已保存值超出上游范围；请修改或清除覆盖。'
      : invalidStep ? '已保存值不符合上游步长；请修改或清除覆盖。' : '';
    return <div className="field vop-field" key={key}>
    <div className="vop-field-label"><span>{unit ? '像素（MP）' : label}</span>{hasValue(key) && <button type="button" className="vop-clear" aria-label={`清除${prefix}${ariaLabel}覆盖`} disabled={disabled || Boolean(parsed.issue)} onClick={() => onChange(key, '')}>清除该覆盖</button>}</div>
    <div className="vop-value-editor">
      {options.length > 0 && <select aria-label={`${prefix}${ariaLabel}选项`} title={controlTitle} disabled={locked} aria-invalid={constraintIssue ? true : undefined}
        value={!hasValue(key) ? '__default__' : selectedOption !== undefined ? `value:${selectedOption}` : '__custom__'}
        onChange={(event) => {
          if (event.target.value === '__default__') onChange(key, '');
          else if (event.target.value.startsWith('value:') && options.includes(event.target.value.slice(6))) onChange(key, event.target.value.slice(6));
        }}>
        <option value="__default__">{displayedDefaultLabel}</option>
        {options.map((option) => <option key={option} value={`value:${option}`}>{optionLabel(option)}</option>)}
        {(!fixedUpstreamChoices || hasValue(key) && selectedOption === undefined) && <option value="__custom__" disabled>{fixedChoices ? `已保存原值：${value}${unit}` : scope === 'batch' ? '自定义值' : '自定义值（在下方输入）'}</option>}
      </select>}
      {!fixedChoices && <input aria-label={`${prefix}${ariaLabel}`} title={controlTitle} type={numericInput || key === 'steps' && (!control || control.kind === 'number') ? 'number' : 'text'} inputMode={control?.kind === 'number' || key !== 'resolution' ? 'decimal' : 'text'}
        min={numericInput || key === 'steps' ? control?.min : undefined} max={numericInput || key === 'steps' ? control?.max : undefined} step={numericInput || key === 'steps' ? control?.step ?? 'any' : undefined}
        value={value} disabled={locked}
        aria-invalid={constraintIssue ? true : undefined}
        placeholder={supported(key) ? scope === 'batch' && options.length > 0 ? '自定义' : defaultValue ? displayedDefaultLabel : '保留原值' : requiresMapping ? source === 'api' ? '模板未配置此参数' : '请先绑定节点' : '使用高级 JSON'}
        onChange={(event) => onChange(key, event.target.value)} />}
      {(upstreamParameters || unit || control?.min !== undefined || control?.max !== undefined || options.length > 0) && <small className={`vop-control-hint${upstreamParameters ? ' vop-upstream-hint' : ''}`} title={controlHint}>{controlHint}</small>}
      {constraintIssue && <small className="vop-constraint-warning" role="status">{constraintIssue}</small>}
      {key === 'steps' && defaultValue && supported(key) && <small className="vop-control-hint vop-default-hint">工作流默认 {defaultValue} 步；留空使用默认值。</small>}
    </div>
    {requiresMapping && hasValue(key) && !available.has(key) && <small className="vop-stale">{source === 'api' ? '接口模板未提供此参数，请清除或修改模板' : '当前工作流未绑定，请清除或重新绑定'}</small>}
  </div>;
  };
  const notes = <>
    {scope === 'batch' && <p className="vop-help">每段统一覆盖时长，不是全片总时长；留空保持原参数。</p>}
    <details className="vop-help vop-help-details"><summary>参数填写说明</summary><p>{upstreamParameters ? '读取到的限制和默认值来自当前连接所选模型的接口说明；未提供限制的项目可选常用值或自定义，常用值是否支持由上游判断。留空保留已有参数或使用接口默认；切换模型不会改写已保存值。' : '时长单位为秒，不自动换算帧数；画面比例按工作流提供的完整选项值提交；分辨率按接口原格式填写，不自动计算宽高。采样步数仅覆盖已绑定字段，留空沿用工作流默认值。'}</p></details>
    {requiresMapping && missing.length > 0 && <div className="vop-unavailable"><span>{source === 'api' ? '接口模板尚未提供' : '尚未绑定'}{missing.join('、')}。</span>{onOpenSettings && <button className="btn small" type="button" disabled={disabled} onClick={onOpenSettings}>配置生成参数</button>}</div>}
  </>;
  return <section className={`video-output-parameters${scope === 'batch' ? ' vop-batch' : ''}`} aria-label={`${prefix}视频生成参数`}>
    <div className="vop-heading"><strong>{scope === 'batch' ? '批量视频生成参数' : '视频生成参数'}</strong><span>留空保持原值</span></div>
    <div className="vop-fields" data-count={1 + Number(showAspectRatio) + Number(showResolution) + Number(showSteps) + pixelKeys.length}>
      {field('duration', '视频时长（秒）', '视频时长（秒）')}
      {showAspectRatio && field('aspect_ratio', '画面比例', '视频画面比例')}
      {showResolution && field('resolution', '分辨率', '视频分辨率')}
      {showSteps && field('steps', '采样步数（步）', '采样步数（步）')}
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
