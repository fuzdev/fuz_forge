<script lang="ts">
	import { format_relative_time } from '@fuzdev/fuz_app/ui/ui_format.ts';

	const { name, email, date }: { name: string; email: string; date: string } = $props();
</script>

<strong>{name}</strong> &lt;{email}&gt; ·
<time datetime={date} title={date}>
	{format_relative_time(date)}
</time>
