import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
};

serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get('Authorization');
    if (!authHeader) {
      return new Response(JSON.stringify({ error: 'Unauthorized' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const supabaseUrl = Deno.env.get('SUPABASE_URL')!;
    const serviceRoleKey = Deno.env.get('NS_SERVICE_ROLE_KEY')!;
    const adminSupabase = createClient(supabaseUrl, serviceRoleKey);

    const token = authHeader.replace('Bearer ', '');
    const payload = JSON.parse(atob(token.split('.')[1]));
    const user_id = payload.sub;
    if (!user_id) {
      return new Response(JSON.stringify({ error: 'Invalid token' }), {
        status: 401, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { item_id, item_type, rating } = await req.json();

    if (!item_id || !item_type || rating === undefined) {
      return new Response(JSON.stringify({ error: 'Missing required fields' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!['theme', 'plugin'].includes(item_type)) {
      return new Response(JSON.stringify({ error: 'Invalid item type' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }
    if (!Number.isInteger(rating) || rating < 0 || rating > 5) {
      return new Response(JSON.stringify({ error: 'Rating must be between 0 and 5' }), {
        status: 400, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    if (rating === 0) {
      const { error: deleteError } = await adminSupabase
        .from('ratings')
        .delete()
        .eq('user_id', user_id)
        .eq('item_id', item_id)
        .eq('item_type', item_type);

      if (deleteError) {
        return new Response(JSON.stringify({ error: deleteError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const table = item_type === 'theme' ? 'themes' : 'plugins';
      const { data: ratings, error: fetchError } = await adminSupabase
        .from('ratings')
        .select('rating')
        .eq('item_id', item_id)
        .eq('item_type', item_type);

      if (fetchError) {
        return new Response(JSON.stringify({ error: fetchError.message }), {
          status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
        });
      }

      const count = ratings.length;
      const avg = count > 0 ? ratings.reduce((sum, r) => sum + r.rating, 0) / count : 0;

      await adminSupabase.from(table).update({ avg_rating: avg, rating_count: count }).eq('id', item_id);

      return new Response(JSON.stringify({ avg_rating: avg, rating_count: count }), {
        status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const { error: upsertError } = await adminSupabase
      .from('ratings')
      .upsert({ user_id, item_id, item_type, rating, updated_at: new Date().toISOString() }, {
        onConflict: 'user_id,item_id,item_type'
      });

    if (upsertError) {
      return new Response(JSON.stringify({ error: upsertError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const table = item_type === 'theme' ? 'themes' : 'plugins';

    const { data: ratings, error: fetchError } = await adminSupabase
      .from('ratings')
      .select('rating')
      .eq('item_id', item_id)
      .eq('item_type', item_type);

    if (fetchError) {
      return new Response(JSON.stringify({ error: fetchError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    const count = ratings.length;
    const avg = count > 0 ? ratings.reduce((sum, r) => sum + r.rating, 0) / count : 0;

    const { error: updateError } = await adminSupabase
      .from(table)
      .update({ avg_rating: avg, rating_count: count })
      .eq('id', item_id);

    if (updateError) {
      return new Response(JSON.stringify({ error: updateError.message }), {
        status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
      });
    }

    return new Response(JSON.stringify({ avg_rating: avg, rating_count: count }), {
      status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });

  } catch (err) {
    return new Response(JSON.stringify({ error: 'Something went wrong' }), {
      status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' }
    });
  }
});
