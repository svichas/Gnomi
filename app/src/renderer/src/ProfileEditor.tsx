import { useState } from 'react';
import { getPersonaSchema } from '@gnomi/simulation/profile/schema.ts';
import type { PersonaSchema, ProfileAttribute, ProfileGroup, Segment } from '@gnomi/simulation/types.ts';
import { ATTRIBUTE_TYPES, choiceValues, customAttribute, parseProfileTemplate, profileProblem, PROFILE_GROUPS, serializeProfileTemplate, setAttributeChoices } from './profile.ts';
import { ProfileAttributeEditor } from './ProfileAttributeEditor.tsx';
import { Button, Card, Field, inputClass, Note, secondaryButton, useAction } from './ui.tsx';

const DEFAULT_IDS = new Set(getPersonaSchema().attributes.map((attribute) => attribute.id));

export function ProfileEditor({ schema, segments, disabled, onSchema }: { schema?: PersonaSchema; segments: Segment[]; disabled: boolean; onSchema(schema: PersonaSchema): void }) {
  const attributes = getPersonaSchema(schema);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [type, setType] = useState<ProfileAttribute['type']>('choice');
  const [choices, setChoices] = useState('');
  const [group, setGroup] = useState<ProfileGroup>('work');
  const [expanded, setExpanded] = useState<ProfileGroup | null>(null);
  const template = useAction();
  const problem = profileProblem(schema);
  const update = (attribute: ProfileAttribute) => onSchema({ ...attributes, attributes: attributes.attributes.map((item) => item.id === attribute.id ? attribute : item) });

  const saveTemplate = () => template.run(async () => {
    const url = URL.createObjectURL(new Blob([serializeProfileTemplate(attributes)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = 'gnomi-profile-template.json';
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    return { ok: true, text: 'Profile template downloaded.' };
  });
  const loadTemplate = (file: File) => template.run(async () => {
    if (file.size > 1_000_000) throw new Error('Choose a profile template smaller than 1 MB.');
    onSchema(parseProfileTemplate(await file.text()));
    return { ok: true, text: 'Template loaded. Save the audience and regenerate personas to apply changed traits.' };
  });

  return <Card title="Profile attributes">
    <fieldset disabled={disabled} className="profile-editor space-y-4 disabled:opacity-60">
      <div className="profile-summary"><strong>{attributes.attributes.filter((attribute) => attribute.enabled).length} traits included</strong><span>{attributes.attributes.filter((attribute) => attribute.enabled && attribute.report_dimension).length} report dimensions</span></div>
      <p className="text-sm text-stone-600">Choose the traits that shape your personas. Required traits stay in their prompts; you can hide them from cards. Changed traits take effect when you generate personas.</p>
      <div className="profile-template-actions">
        <Button onClick={() => void saveTemplate()} disabled={template.busy || !!problem}>Save template</Button>
        <label className={`${secondaryButton} profile-load-template cursor-pointer`}>Load template<input type="file" accept=".json,application/json" aria-label="Load profile template" className="sr-only" disabled={template.busy} onChange={(event) => { const file = event.target.files?.[0]; if (file) void loadTemplate(file); event.target.value = ''; }} /></label>
        <Button onClick={() => onSchema(getPersonaSchema())}>Restore default attributes</Button>
      </div>
      {template.outcome && <Note tone={template.outcome.ok ? 'ok' : 'error'}>{template.outcome.text}</Note>}
      {problem && <Note tone="error">{problem}</Note>}
      {(Object.entries(PROFILE_GROUPS) as [ProfileGroup, string][]).map(([id, label]) => {
        const members = attributes.attributes.filter((attribute) => attribute.group === id);
        return <details key={id} open={expanded === id} onToggle={(event) => { if (event.currentTarget.open) setExpanded(id); }} className="profile-attribute-group">
          <summary className="cursor-pointer px-4 py-3 text-sm font-semibold text-stone-900">{label} <span className="font-normal text-stone-500">({members.filter((attribute) => attribute.enabled).length} of {members.length} included)</span></summary>
          <ul className="space-y-3 border-t border-stone-200 p-3">{members.map((attribute) => <ProfileAttributeEditor key={attribute.id} attribute={attribute} custom={!DEFAULT_IDS.has(attribute.id)} segments={segments} onChange={update} onRemove={() => onSchema({ ...attributes, attributes: attributes.attributes.filter((item) => item.id !== attribute.id) })} />)}</ul>
        </details>;
      })}
      {adding ? <form className="profile-new-attribute space-y-4" aria-label="New profile attribute" onSubmit={(event) => {
        event.preventDefault();
        let added = { ...customAttribute(attributes, name, type), description: description.trim(), group };
        if (type === 'choice') added = setAttributeChoices(added, choiceValues(choices));
        onSchema({ ...attributes, attributes: [...attributes.attributes, added] });
        setExpanded(group);
        setAdding(false);
        setName(''); setDescription(''); setChoices('');
      }}>
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Attribute name"><input value={name} onChange={(event) => setName(event.target.value)} maxLength={100} className={inputClass} /></Field>
          <Field label="Attribute type"><select value={type} onChange={(event) => setType(event.target.value as ProfileAttribute['type'])} className={inputClass}>{Object.entries(ATTRIBUTE_TYPES).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
          <Field label="Attribute group"><select value={group} onChange={(event) => setGroup(event.target.value as ProfileGroup)} className={inputClass}>{Object.entries(PROFILE_GROUPS).map(([id, label]) => <option key={id} value={id}>{label}</option>)}</select></Field>
        </div>
        <Field label="Attribute description" hint="What does this trait mean for how they use the product?"><textarea rows={2} value={description} onChange={(event) => setDescription(event.target.value)} className={inputClass} /></Field>
        {type === 'choice' && <Field label="Attribute choices" hint="One choice per line."><textarea rows={3} value={choices} onChange={(event) => setChoices(event.target.value)} className={inputClass} /></Field>}
        <div className="flex gap-3"><Button type="submit" disabled={!name.trim() || !description.trim() || type === 'choice' && choiceValues(choices).length === 0} variant="primary">Add attribute</Button><Button onClick={() => setAdding(false)}>Cancel</Button></div>
      </form> : <Button onClick={() => setAdding(true)}>Add custom attribute</Button>}
    </fieldset>
  </Card>;
}
